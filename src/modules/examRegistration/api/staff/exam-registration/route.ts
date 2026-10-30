import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { requireRole, toAuthResponse, type VerifiedSession } from "@/lib/dal";
import {
  countStaffClassExamRegistrations,
  listStaffClassExamRegistrations,
} from "../../../lib/exam-registration";

const noStore = { "Cache-Control": "no-store" };

/** GET：教職員兼導師讀取本人班級目前開放場次；名單可延遲載入或只取 count。 */
export async function GET(request: NextRequest) {
  // 兼導師班級：即使後端失敗也回傳，讓頁面仍能顯示標題下的班級名稱
  let classCode = "";
  try {
    const limited = enforceRateLimit(
      request,
      "exam-registration-staff",
      RATE.EXAM_REGISTRATION_STAFF.limit,
      RATE.EXAM_REGISTRATION_STAFF.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("staff");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("examRegistration", session);
    if (gate) return gate;

    const entry = (session as VerifiedSession).__entry;
    const attribute = typeof entry?.attribute === "string" ? entry.attribute.trim() : "";
    classCode = typeof entry?.classCode === "string" ? entry.classCode.trim() : "";
    if (attribute !== "兼導師" || !classCode) {
      return NextResponse.json(
        { success: false, message: "此功能僅提供給有班級代碼的兼導師。" },
        { status: 403, headers: noStore }
      );
    }

    if (request.nextUrl.searchParams.get("summary") === "counts") {
      const counts = await countStaffClassExamRegistrations(classCode);
      return NextResponse.json({ success: true, classCode, counts }, { headers: noStore });
    }

    const includeStudents = request.nextUrl.searchParams.get("includeStudents") === "1";
    const eventId = request.nextUrl.searchParams.get("eventId")?.trim() || undefined;
    const events = await listStaffClassExamRegistrations(classCode, includeStudents, eventId);
    return NextResponse.json({ success: true, classCode, events }, { headers: noStore });
  } catch (error) {
    console.error("Staff exam registration GET error:", error);
    return NextResponse.json(
      { success: false, message: "載入班級報名資料失敗。", classCode },
      { status: 500, headers: noStore }
    );
  }
}
