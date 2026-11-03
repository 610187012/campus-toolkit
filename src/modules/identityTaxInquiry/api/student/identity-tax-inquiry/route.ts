import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireRole, toAuthResponse, type VerifiedSession } from "@/lib/dal";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  getRecord,
  getSettings,
  saveStudentRecord,
} from "../../../lib/identity-tax-inquiry";
import {
  MAINTENANCE_TITLE,
  parseRecordInput,
  periodLabelOf,
  windowStateOf,
} from "../../../types/identity-tax-inquiry";

const noStore = { "Cache-Control": "no-store" };

interface StudentIdentity {
  uid: string;
  name: string;
  grade: string;
  classCode: string;
  className: string;
}

/** 由名冊條目（`session.__entry`）組出學生身分；缺年級＝非本校名冊學生 */
function studentIdentityOf(session: VerifiedSession): StudentIdentity | null {
  const entry = session.__entry;
  const grade = entry && typeof entry.grade === "string" ? entry.grade : "";
  if (!grade) return null;
  return {
    uid: session.uid,
    name:
      entry && typeof entry.name === "string" && entry.name
        ? entry.name
        : session.displayName || session.account,
    grade,
    classCode: entry && typeof entry.classCode === "string" ? entry.classCode : "",
    className: entry && typeof entry.className === "string" ? entry.className : "",
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

/** GET：設定＋本學期我的確認紀錄＋確認期間狀態 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "identity-tax-inquiry-list",
      RATE.IDENTITY_TAX_INQUIRY_LIST.limit,
      RATE.IDENTITY_TAX_INQUIRY_LIST.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("identityTaxInquiry", session);
    if (gate) return gate;

    const student = studentIdentityOf(session as VerifiedSession);
    if (!student) {
      return NextResponse.json(
        { success: false, message: "查無名冊身分資料，無法使用本功能" },
        { status: 403, headers: noStore }
      );
    }

    const settings = await getSettings();
    const period = periodLabelOf(await getCurrentPeriod());
    const windowState = windowStateOf(settings);

    if (!settings.enabled) {
      return NextResponse.json(
        {
          success: true,
          maintenance: true,
          settings,
          record: null,
          period,
          windowState,
          student: { name: student.name, className: student.className },
        },
        { headers: noStore }
      );
    }

    // 學生只需自己的紀錄；不讀班級名冊（避免無謂的 Firestore 讀取）
    const record = await getRecord(period, student.uid);
    return NextResponse.json(
      {
        success: true,
        settings,
        record,
        period,
        windowState,
        student: { name: student.name, className: student.className },
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("identityTaxInquiry student GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "讀取資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/** POST：儲存草稿；送出確認時須附本次個人資料授權與告知版本。 */
export async function POST(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "identity-tax-inquiry-student",
      RATE.IDENTITY_TAX_INQUIRY_STUDENT.limit,
      RATE.IDENTITY_TAX_INQUIRY_STUDENT.windowMs
    );
    if (limited) return limited;

    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("identityTaxInquiry", session);
    if (gate) return gate;

    const student = studentIdentityOf(session as VerifiedSession);
    if (!student) {
      return NextResponse.json(
        { success: false, message: "查無名冊身分資料，無法使用本功能" },
        { status: 403, headers: noStore }
      );
    }

    const settings = await getSettings();
    if (!settings.enabled) {
      return NextResponse.json(
        { success: false, message: MAINTENANCE_TITLE },
        { status: 403, headers: noStore }
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const confirm = body?.action === "confirm";
    const parsed = parseRecordInput(body, settings, confirm ? "confirm" : "draft");
    if (!parsed.ok) {
      return NextResponse.json(
        { success: false, message: parsed.message },
        { status: 400, headers: noStore }
      );
    }

    const result = await saveStudentRecord({
      period: periodLabelOf(await getCurrentPeriod()),
      student,
      value: parsed.value,
      confirm,
      settings,
    });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status, headers: noStore }
      );
    }

    await logActivity({
      userId: student.uid,
      role: session.role,
      action: confirm
        ? "identity_tax_inquiry_record_confirmed"
        : "identity_tax_inquiry_record_saved",
      ip: getClientIp(request),
      details: `${confirm ? "送出" : "儲存"}註冊身分確認${confirm ? "：" : "草稿："}${
        result.record.identities.join("、") || "（未選身分別）"
      }`,
    });

    return NextResponse.json(
      {
        success: true,
        record: result.record,
        message: confirm ? "已送出註冊身分確認" : "已儲存草稿",
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("identityTaxInquiry student POST error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "儲存失敗") },
      { status: 500, headers: noStore }
    );
  }
}
