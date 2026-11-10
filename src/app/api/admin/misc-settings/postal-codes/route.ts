import { NextRequest, NextResponse } from "next/server";
import { requireAdminModule, toAuthResponse } from "@/lib/dal";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp, logActivity } from "@/lib/audit";
import { serverErrorMessage } from "@/lib/api-error";
import { getPostalCodeOptions, savePostalCodeOptions } from "@/lib/postal-codes";
import {
  POSTAL_CODE_MAX_LENGTH,
  POSTAL_CODE_OPTIONS_MAX,
  POSTAL_DISTRICT_MAX_LENGTH,
  type PostalCodeOption,
} from "@/types/postal-codes";
import { readJsonBody } from "@/lib/http-body";

const noStore = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 200_000;

export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "school-codes",
      RATE.SCHOOL_CODES_GET.limit,
      RATE.SCHOOL_CODES_GET.windowMs
    );
    if (limited) return limited;

    const { denial } = await requireAdminModule("miscSettings");
    if (denial) return toAuthResponse(denial);

    const options = await getPostalCodeOptions();
    return NextResponse.json({ success: true, options }, { headers: noStore });
  } catch (error) {
    console.error("Postal code options GET error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "讀取郵遞區號設定失敗") },
      { status: 500, headers: noStore }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "school-codes",
      RATE.SCHOOL_CODES_MUTATE.limit,
      RATE.SCHOOL_CODES_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireAdminModule("miscSettings");
    if (denial) return toAuthResponse(denial);

    const parsed = await readJsonBody<Record<string, unknown>>(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ success: false, message: "無效的郵遞區號設定" }, { status: 400 });
    }
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return NextResponse.json({ success: false, message: "郵遞區號資料過大" }, { status: 413 });
    }
    const rawOptions = (body as Record<string, unknown>).options;
    if (!Array.isArray(rawOptions) || rawOptions.length > POSTAL_CODE_OPTIONS_MAX) {
      return NextResponse.json(
        { success: false, message: `郵遞區號選項最多 ${POSTAL_CODE_OPTIONS_MAX} 筆` },
        { status: 400 }
      );
    }

    const options: PostalCodeOption[] = [];
    const seen = new Set<string>();
    for (const raw of rawOptions) {
      const item = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const code = typeof item?.code === "string" ? item.code.trim() : "";
      const district = typeof item?.district === "string" ? item.district.trim() : "";
      if (!/^\d{3}$/.test(code) || !district || district.length > POSTAL_DISTRICT_MAX_LENGTH) {
        return NextResponse.json(
          {
            success: false,
            message: `每筆資料需包含 3 位數區號及 1～${POSTAL_DISTRICT_MAX_LENGTH} 字鄉鎮市區名稱`,
          },
          { status: 400 }
        );
      }
      if (code.length > POSTAL_CODE_MAX_LENGTH) {
        return NextResponse.json({ success: false, message: "區號長度無效" }, { status: 400 });
      }
      const key = `${code}\u0000${district}`;
      if (seen.has(key)) {
        return NextResponse.json(
          { success: false, message: `郵遞區號與鄉鎮市區重複：${code} ${district}` },
          { status: 400 }
        );
      }
      seen.add(key);
      options.push({ code, district });
    }

    await savePostalCodeOptions(options);
    await logActivity({
      userId: session.uid,
      role: "admin",
      action: "postal_codes_updated",
      ip: getClientIp(request),
      details: `更新郵遞區號選項（${options.length} 筆）`,
    });
    return NextResponse.json(
      { success: true, options, message: "郵遞區號設定已儲存" },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Postal code options PUT error:", error);
    return NextResponse.json(
      { success: false, message: serverErrorMessage(error, "儲存郵遞區號設定失敗") },
      { status: 500, headers: noStore }
    );
  }
}
