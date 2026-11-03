import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { requireRole, toAuthResponse, type VerifiedSession } from "@/lib/dal";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { getFeatureModuleRoles } from "@/lib/feature-modules";
import { getCurrentPeriod } from "@/lib/settings-server";
import {
  getRecord,
  getSettings,
  linkedChildForParent,
  maskRecordForParent,
} from "../../../lib/identity-tax-inquiry";
import {
  IDENTITY_TAX_INQUIRY_VALUE,
  periodLabelOf,
  windowStateOf,
} from "../../../types/identity-tax-inquiry";

const noStore = { "Cache-Control": "no-store" };

function errorMessage(error: unknown, fallback: string): string {
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

/** GET：家長唯讀查看綁定子女本學期的註冊身分確認（身分證字號遮蔽） */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "identity-tax-inquiry-list",
      RATE.IDENTITY_TAX_INQUIRY_LIST.limit,
      RATE.IDENTITY_TAX_INQUIRY_LIST.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("parent");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled(IDENTITY_TAX_INQUIRY_VALUE, session);
    if (gate) return gate;

    const roles = await getFeatureModuleRoles();
    if (roles.identityTaxInquiry?.parent !== true) {
      return NextResponse.json(
        { success: false, message: "家長尚未開放此功能入口" },
        { status: 403, headers: noStore }
      );
    }

    const entry = (session as VerifiedSession).__entry;
    const child = entry ? await linkedChildForParent(entry) : null;
    if (!child) {
      return NextResponse.json(
        {
          success: false,
          message: "家長名冊無法唯一對應有效子女資料，請聯絡承辦確認學號、年級與班級",
        },
        { status: 403, headers: noStore }
      );
    }

    const settings = await getSettings();
    const period = periodLabelOf(await getCurrentPeriod());
    if (!settings.enabled) {
      return NextResponse.json(
        {
          success: true,
          maintenance: true,
          child: null,
          record: null,
          settings,
          period,
          windowState: windowStateOf(settings),
        },
        { headers: noStore }
      );
    }

    const record = await getRecord(period, child.uid);
    return NextResponse.json(
      {
        success: true,
        child,
        record: record ? maskRecordForParent(record) : null,
        settings,
        period,
        windowState: windowStateOf(settings),
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("identityTaxInquiry parent GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "讀取資料失敗") },
      { status: 500, headers: noStore }
    );
  }
}
