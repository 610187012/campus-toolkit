import { NextRequest, NextResponse } from "next/server";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import { getFeatureModuleRoles } from "@/lib/feature-modules";
import { requireRole, toAuthResponse } from "@/lib/dal";
import type { VerifiedSession } from "@/lib/dal";
import {
  ExamRegistrationError,
  linkedStudentIdentityForParent,
  listStudentExamEvents,
} from "../../../lib/exam-registration";

const noStore = { "Cache-Control": "no-store" };

/** GET：家長依名冊綁定的子女資料唯讀查看可報名場次與登錄結果。 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "exam-registration-list",
      RATE.EXAM_REGISTRATION_LIST.limit,
      RATE.EXAM_REGISTRATION_LIST.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("parent");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("examRegistration", session);
    if (gate) return gate;

    const roles = await getFeatureModuleRoles();
    if (roles.examRegistration?.parent !== true) {
      return NextResponse.json(
        { success: false, message: "家長尚未開放此功能入口" },
        { status: 403, headers: noStore }
      );
    }

    const parentEntry = (session as VerifiedSession).__entry;
    const child = parentEntry ? await linkedStudentIdentityForParent(parentEntry) : null;
    if (!child) {
      return NextResponse.json(
        { success: false, message: "家長名冊無法唯一對應有效子女資料，請聯絡承辦確認學號、年級與班級" },
        { status: 403, headers: noStore }
      );
    }

    const events = await listStudentExamEvents(child);
    return NextResponse.json(
      {
        success: true,
        child: {
          name: child.name,
          studentId: child.studentId,
          grade: child.grade,
          classCode: child.classCode,
          className: child.className,
          seatNo: child.seatNo,
        },
        events,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Parent exam registration GET error:", error);
    return NextResponse.json(
      {
        success: false,
        message:
          error instanceof ExamRegistrationError
            ? error.message
            : process.env.NODE_ENV !== "production" && error instanceof Error
              ? error.message
              : "系統錯誤",
      },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}
