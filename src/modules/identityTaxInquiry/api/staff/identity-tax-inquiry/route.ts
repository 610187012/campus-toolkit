import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { requireRole, toAuthResponse, type VerifiedSession } from "@/lib/dal";
import { managedModulesOf } from "@/lib/roster";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  buildInquiryRows,
  getSettings,
  statsOf,
  updateTaxInquiry,
} from "../../../lib/identity-tax-inquiry";
import {
  IDENTITY_TAX_INQUIRY_VALUE,
  MAINTENANCE_TITLE,
  periodLabelOf,
  windowStateOf,
  type StaffRoles,
} from "../../../types/identity-tax-inquiry";

const noStore = { "Cache-Control": "no-store" };

function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

function staffRolesOf(session: VerifiedSession): StaffRoles {
  const entry = session.__entry;
  const attribute = entry && typeof entry.attribute === "string" ? entry.attribute.trim() : "";
  const classCode = entry && typeof entry.classCode === "string" ? entry.classCode.trim() : "";
  const grant = managedModulesOf(entry).find((item) => item.module === IDENTITY_TAX_INQUIRY_VALUE);
  return {
    isTutor: attribute === "兼導師" && Boolean(classCode),
    classCode,
    permissions: grant?.permissions ?? [],
  };
}

/** GET：本班（兼導師）或被指派權限者的確認名冊 `?classCode=` */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "identity-tax-inquiry-staff",
      RATE.IDENTITY_TAX_INQUIRY_STAFF.limit,
      RATE.IDENTITY_TAX_INQUIRY_STAFF.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("staff");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled(IDENTITY_TAX_INQUIRY_VALUE, session);
    if (gate) return gate;

    const settings = await getSettings();
    const roles = staffRolesOf(session as VerifiedSession);
    const canView =
      roles.isTutor || roles.permissions.includes("viewRecords") || roles.permissions.includes("taxInquiry");
    if (!canView) {
      return NextResponse.json(
        {
          success: false,
          message: "此功能僅提供給兼導師，或被指派「查看名冊／財稅查調」權限的教職員。",
          roles,
        },
        { status: 403, headers: noStore }
      );
    }

    const periodInfo = await getCurrentPeriod();
    const period = periodLabelOf(periodInfo);
    if (!settings.enabled) {
      return NextResponse.json(
        {
          success: true,
          maintenance: true,
          settings,
          roles,
          period,
          windowState: windowStateOf(settings),
          rows: [],
          stats: statsOf([]),
        },
        { headers: noStore }
      );
    }

    // 兼導師且沒有「查看名冊」權限時，一律只讀自己班級
    const byPermission = roles.permissions.includes("viewRecords") || roles.permissions.includes("taxInquiry");
    const requested = request.nextUrl.searchParams.get("classCode")?.trim() || "";
    const classCode = roles.isTutor && !byPermission ? roles.classCode : requested || undefined;
    const rows = await buildInquiryRows({ period: periodInfo, classCode });
    return NextResponse.json(
      {
        success: true,
        settings,
        roles,
        period,
        windowState: windowStateOf(settings),
        classCode: classCode ?? "",
        rows,
        stats: statsOf(rows),
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("identityTaxInquiry staff GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "讀取名冊失敗") },
      { status: 500, headers: noStore }
    );
  }
}

/** POST：`{ studentUid, status: "pending"|"done"|"exempt", note }` 更新財稅查調狀態 */
export async function POST(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "identity-tax-inquiry-staff-mutate",
      RATE.IDENTITY_TAX_INQUIRY_STAFF.limit,
      RATE.IDENTITY_TAX_INQUIRY_STAFF.windowMs
    );
    if (limited) return limited;

    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const { session, denial } = await requireRole("staff");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled(IDENTITY_TAX_INQUIRY_VALUE, session);
    if (gate) return gate;

    const settings = await getSettings();
    if (!settings.enabled) {
      return NextResponse.json(
        { success: false, message: MAINTENANCE_TITLE },
        { status: 403, headers: noStore }
      );
    }

    const roles = staffRolesOf(session as VerifiedSession);
    const byPermission = roles.permissions.includes("taxInquiry");
    if (!roles.isTutor && !byPermission) {
      return NextResponse.json(
        { success: false, message: "你沒有財稅查調作業權限。" },
        { status: 403, headers: noStore }
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const studentUid = typeof body?.studentUid === "string" ? body.studentUid.trim() : "";
    const status =
      body?.status === "done" || body?.status === "exempt" || body?.status === "pending"
        ? body.status
        : null;
    const note = typeof body?.note === "string" ? body.note : "";
    if (!studentUid) {
      return NextResponse.json(
        { success: false, message: "缺少學生識別" },
        { status: 400, headers: noStore }
      );
    }
    if (!status) {
      return NextResponse.json(
        { success: false, message: "查調狀態不正確" },
        { status: 400, headers: noStore }
      );
    }

    const result = await updateTaxInquiry({
      period: periodLabelOf(await getCurrentPeriod()),
      studentUid,
      status,
      note,
      staffUid: session.uid,
      staffName: session.displayName || session.account,
      // 只有「財稅查調」權限可跨班；兼導師僅限本班
      scopeClassCode: byPermission ? null : roles.classCode,
    });
    if (!result.ok) {
      return NextResponse.json(
        { success: false, message: result.message },
        { status: result.status, headers: noStore }
      );
    }

    await logActivity({
      userId: session.uid,
      role: session.role,
      action: "identity_tax_inquiry_tax_updated",
      ip: getClientIp(request),
      details: `更新財稅查調狀態（${status}）：${result.record.studentName}`,
    });

    return NextResponse.json(
      { success: true, record: result.record, message: "已更新財稅查調狀態" },
      { headers: noStore }
    );
  } catch (error) {
    console.error("identityTaxInquiry staff POST error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "更新失敗") },
      { status: 500, headers: noStore }
    );
  }
}
