import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireModulePermission, toAuthResponse } from "@/lib/dal";
import { getCurrentPeriod } from "@/lib/settings-server";
import { normalizeRichHtmlField } from "../../../lib/rich-text";
import {
  buildInquiryCsv,
  buildInquiryRows,
  getSettings,
  saveSettings,
  statsOf,
} from "../../../lib/identity-tax-inquiry";
import {
  IDENTITY_TAX_INQUIRY_VALUE,
  normalizeSettings,
  periodLabelOf,
  windowStateOf,
  type IdentityTaxInquirySettings,
} from "../../../types/identity-tax-inquiry";

const noStore = { "Cache-Control": "no-store" };

function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

type PermissionContext =
  | { kind: "admin" }
  | { kind: "delegated"; permissions: string[] };

function can(context: PermissionContext, permission: string): boolean {
  if (context.kind === "admin") return true;
  return context.permissions.includes(permission);
}

/** GET：設定與名冊（`?mode=records`）、查調名冊 CSV（`?format=csv`） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "identity-tax-inquiry-admin",
      RATE.IDENTITY_TAX_INQUIRY_ADMIN.limit,
      RATE.IDENTITY_TAX_INQUIRY_ADMIN.windowMs
    );
    if (limited) return limited;

    const { context, denial } = await requireModulePermission(IDENTITY_TAX_INQUIRY_VALUE);
    if (denial) return toAuthResponse(denial);
    const permission: PermissionContext =
      context.kind === "admin"
        ? { kind: "admin" }
        : { kind: "delegated", permissions: context.permissions };

    const settings = await getSettings();
    const periodInfo = await getCurrentPeriod();
    const period = periodLabelOf(periodInfo);
    const classCode = request.nextUrl.searchParams.get("classCode")?.trim() || undefined;
    const format = request.nextUrl.searchParams.get("format");
    const mode = request.nextUrl.searchParams.get("mode");

    if (format === "csv") {
      if (!can(permission, "export")) {
        return NextResponse.json(
          { success: false, message: "你沒有匯出查調名冊的權限" },
          { status: 403, headers: noStore }
        );
      }
      const rows = await buildInquiryRows({ period: periodInfo, classCode });
      const csv = buildInquiryCsv(rows, true);
      const filename = `註冊身分與財稅查調_${period}${classCode ? `_${classCode}` : ""}.csv`;
      return new NextResponse(`\uFEFF${csv}`, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "Cache-Control": "no-store",
        },
      });
    }

    if (mode === "records") {
      if (!can(permission, "viewRecords") && !can(permission, "taxInquiry") && !can(permission, "configure")) {
        return NextResponse.json(
          { success: false, message: "你沒有查看名冊的權限" },
          { status: 403, headers: noStore }
        );
      }
      const rows = await buildInquiryRows({ period: periodInfo, classCode });
      return NextResponse.json(
        {
          success: true,
          settings,
          period,
          windowState: windowStateOf(settings),
          classCode: classCode ?? "",
          rows,
          stats: statsOf(rows),
        },
        { headers: noStore }
      );
    }

    const rows = await buildInquiryRows({ period: periodInfo });
    return NextResponse.json(
      {
        success: true,
        settings,
        period,
        windowState: windowStateOf(settings),
        stats: statsOf(rows),
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("identityTaxInquiry admin GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "讀取資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/** POST：儲存管理規則 */
export async function POST(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "identity-tax-inquiry-admin-mutate",
      RATE.IDENTITY_TAX_INQUIRY_ADMIN.limit,
      RATE.IDENTITY_TAX_INQUIRY_ADMIN.windowMs
    );
    if (limited) return limited;

    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const { context, denial } = await requireModulePermission(
      IDENTITY_TAX_INQUIRY_VALUE,
      "configure"
    );
    if (denial) return toAuthResponse(denial);
    const session = context.session;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json(
        { success: false, message: "缺少設定內容" },
        { status: 400, headers: noStore }
      );
    }

    const openAt = typeof body.openAt === "number" && body.openAt > 0 ? body.openAt : null;
    const closeAt = typeof body.closeAt === "number" && body.closeAt > 0 ? body.closeAt : null;
    if (openAt !== null && closeAt !== null && closeAt <= openAt) {
      return NextResponse.json(
        { success: false, message: "確認截止時間必須晚於開放時間" },
        { status: 400, headers: noStore }
      );
    }

    const optionsRaw = Array.isArray(body.identityOptions) ? body.identityOptions : [];
    if (optionsRaw.length === 0) {
      return NextResponse.json(
        { success: false, message: "請至少設定一個身分別選項" },
        { status: 400, headers: noStore }
      );
    }
    const draftSettings = normalizeSettings({
      enabled: body.enabled === true,
      openAt,
      closeAt,
      instructions: normalizeRichHtmlField(body.instructions, 20000),
      identityOptions: optionsRaw,
      updatedAt: Date.now(),
    });
    if (draftSettings.identityOptions.length === 0) {
      return NextResponse.json(
        { success: false, message: "請至少設定一個有效的身分別名稱" },
        { status: 400, headers: noStore }
      );
    }
    const labelSet = new Set<string>();
    const duplicate = draftSettings.identityOptions.find((option) => {
      if (labelSet.has(option.label)) return true;
      labelSet.add(option.label);
      return false;
    });
    if (duplicate) {
      return NextResponse.json(
        { success: false, message: `身分別名稱重複：${duplicate.label}` },
        { status: 400, headers: noStore }
      );
    }
    const next: IdentityTaxInquirySettings = {
      ...draftSettings,
      enabled: body.enabled === true,
      openAt,
      closeAt,
      instructions: normalizeRichHtmlField(body.instructions, 20000),
      updatedAt: Date.now(),
    };

    const saved = await saveSettings(next);
    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "identity_tax_inquiry_settings_updated",
      ip: getClientIp(request),
      details: `更新註冊身分與財稅查調設定（${saved.enabled ? "啟用" : "停用"}）`,
    });

    return NextResponse.json({ success: true, settings: saved, message: "已儲存設定" }, { headers: noStore });
  } catch (error) {
    console.error("identityTaxInquiry admin POST error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "儲存設定失敗") },
      { status: 500, headers: noStore }
    );
  }
}
