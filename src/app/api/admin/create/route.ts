import { NextRequest, NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase-admin";
import { hashPassword } from "@/lib/auth";
import { requireSuperAdmin, toAuthResponse } from "@/lib/dal";
import { logActivity, getClientIp } from "@/lib/audit";
import { enforceRateLimitShared, RATE } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import {
  normalizeEmail,
  normalizeAccount,
  isStrongPassword,
  PASSWORD_REQUIREMENT_MESSAGE,
  EMAIL_FORMAT_MESSAGE,
  ACCOUNT_FORMAT_MESSAGE,
} from "@/lib/validation";
import { getCurrentPeriod } from "@/lib/settings-server";
import { buildAccountRecord, buildRosterEntry, rosterEntryId } from "@/lib/roster";
import { ADMIN_MODULE_VALUES, USER_COLLECTION } from "@/types/users";
import { rosterCollection } from "@/types/roster";
import { serverErrorMessage } from "@/lib/api-error";
import { readJsonBody } from "@/lib/http-body";

/** 管理員名冊總筆數（不分學期）：>0 即代表已建立過管理員，不可再走初始建立 */
async function adminCount(): Promise<number> {
  const snap = await getAdminDb().collection(rosterCollection("admin")).count().get();
  return snap.data().count;
}

/** 供 /setup 判斷是否仍可建立首任管理員（不揭露環境變數名稱） */
export async function GET(request: NextRequest) {
  try {
    const limited = await enforceRateLimitShared(
      request,
      "admin-create-status",
      RATE.ADMIN_CREATE_STATUS.limit,
      RATE.ADMIN_CREATE_STATUS.windowMs
    );
    if (limited) return limited;

    const existingCount = await adminCount();
    const available = existingCount === 0 && process.env.ALLOW_BOOTSTRAP_ADMIN === "true";
    return NextResponse.json(
      { success: true, available },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    console.error("Admin create status error:", error);
    return NextResponse.json({ success: false, available: false }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = await enforceRateLimitShared(
      request,
      "admin-create",
      RATE.ADMIN_CREATE.limit,
      RATE.ADMIN_CREATE.windowMs
    );
    if (limited) return limited;

    const ip = getClientIp(request);
    const usersRef = getAdminDb().collection(USER_COLLECTION);
    const existingCount = await adminCount();
    const isBootstrap = existingCount === 0;
    const bootstrapEnabled = process.env.ALLOW_BOOTSTRAP_ADMIN === "true";

    // Bootstrap（首任管理員）需顯式開啟，避免資料被清空後免驗證建管
    if (isBootstrap && !bootstrapEnabled) {
      return NextResponse.json(
        { success: false, message: "初始管理員建立已停用" },
        { status: 403 }
      );
    }

    let session = null;
    if (!isBootstrap) {
      // 新增管理員一律建立「超級」，故須由超級管理員執行（一般管理員不得自行升級代理人選）
      const { session: s, denial } = await requireSuperAdmin("僅超級管理員可新增管理員");
      if (denial) return toAuthResponse(denial);
      session = s;
    }

    const parsed = await readJsonBody<{
      email?: unknown;
      account?: unknown;
      password?: unknown;
      name?: unknown;
      displayName?: unknown;
    }>(request);
    if (!parsed.ok) return parsed.response;
    const { email, account, password, name, displayName } = parsed.data;
    // 統一用 name；相容舊欄位 displayName（舊介面仍可能傳）
    const normName =
      String(typeof name === "string" ? name : (displayName ?? "")).slice(0, 64);

    const rawEmail = typeof email === "string" ? email.trim() : "";
    const rawAccount = typeof account === "string" ? account.trim() : "";
    const normEmail = rawEmail ? normalizeEmail(rawEmail) : null;
    const normAccount = rawAccount ? normalizeAccount(rawAccount) : null;
    if (rawEmail && !normEmail) {
      return NextResponse.json({ success: false, message: EMAIL_FORMAT_MESSAGE }, { status: 400 });
    }
    if (rawAccount && !normAccount) {
      return NextResponse.json({ success: false, message: ACCOUNT_FORMAT_MESSAGE }, { status: 400 });
    }
    // 電子郵件與帳號至少填一個（登入識別用），姓名與密碼必填
    if ((!normEmail && !normAccount) || !password || !normName) {
      return NextResponse.json(
        { success: false, message: "請填寫完整資訊（電子郵件地址與帳號至少填寫一個）" },
        { status: 400 }
      );
    }
    if (!isStrongPassword(password)) {
      return NextResponse.json(
        { success: false, message: PASSWORD_REQUIREMENT_MESSAGE },
        { status: 400 }
      );
    }

    if (normEmail) {
      const emailSnapshot = await usersRef.where("email", "==", normEmail).limit(1).get();
      if (!emailSnapshot.empty) {
        return NextResponse.json(
          { success: false, message: "此電子郵件已被使用" },
          { status: 409 }
        );
      }
    }

    if (normAccount) {
      const accountSnapshot = await usersRef.where("account", "==", normAccount).limit(1).get();
      if (!accountSnapshot.empty) {
        return NextResponse.json(
          { success: false, message: "此帳號已被使用" },
          { status: 409 }
        );
      }
    }

    // costFactor 不接受 request body 指定：固定使用預設 12，避免被降為弱成本雜湊
    const passwordHash = await hashPassword(password);
    const newAdmin = buildAccountRecord(
      { email: normEmail || "", account: normAccount || "", name: normName },
      passwordHash
    );

    let docRef;
    if (isBootstrap) {
      // Transaction：再次確認仍無管理員才寫入，避免並發重複建管
      try {
        docRef = await getAdminDb().runTransaction(async (tx) => {
          const adminCol = getAdminDb().collection(rosterCollection("admin"));
          const snap = await tx.get(adminCol.limit(1));
          if (!snap.empty) {
            throw new Error("BOOTSTRAP_ALREADY_DONE");
          }
          const ref = usersRef.doc();
          tx.set(ref, newAdmin);
          return ref;
        });
      } catch (txError) {
        if (txError instanceof Error && txError.message === "BOOTSTRAP_ALREADY_DONE") {
          return NextResponse.json(
            { success: false, message: "建立失敗，管理員可能已存在" },
            { status: 409 }
          );
        }
        throw txError;
      }
    } else {
      docRef = await usersRef.add(newAdmin);
    }

    // 管理員身分名冊（當期）：預設超級管理員＝功能模組全開
    const period = await getCurrentPeriod();
    await getAdminDb()
      .collection(rosterCollection("admin"))
      .doc(rosterEntryId(docRef.id, period))
      .set(
        buildRosterEntry(
          docRef.id,
          "admin",
          period,
          { attribute: "超級", modules: ADMIN_MODULE_VALUES.slice() },
          { email: normEmail || "", account: newAdmin.account || "", name: normName }
        )
      );

    await logActivity({
      userId: session?.uid,
      role: "admin",
      action: "admin_created",
      ip,
      details: isBootstrap
        ? `建立初始管理員 ${newAdmin.account}`
        : `由 ${session?.account || "管理員"} 建立 ${newAdmin.account}`,
    });

    return NextResponse.json({
      success: true,
      uid: docRef.id,
      message: "管理員建立成功",
    });
  } catch (error) {
    console.error("Create admin error:", error);
    return NextResponse.json({
      success: false,
      message: serverErrorMessage(error, "系統錯誤，請稍後再試"),
    }, { status: 500 });
  }
}
