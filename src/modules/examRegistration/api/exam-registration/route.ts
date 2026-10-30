import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/csrf";
import { enforceRateLimit, RATE } from "@/lib/rate-limit";
import { getClientIp } from "@/lib/audit";
import { requireRole, toAuthResponse } from "@/lib/dal";
import type { VerifiedSession } from "@/lib/dal";
import { requireFeatureModuleEnabled } from "@/lib/module-gate";
import {
  ExamRegistrationError,
  archiveExamRegistration,
  listStudentExamEvents,
  upsertExamRegistration,
  withdrawExamRegistration,
} from "../../lib/exam-registration";
import type { StudentIdentity } from "../../lib/exam-registration";

const noStore = { "Cache-Control": "no-store" };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ExamRegistrationError) return error.message;
  if (process.env.NODE_ENV !== "production" && error instanceof Error) return error.message;
  return fallback;
}

/** 由驗證基線的名冊條目取出學生身分（對象過濾與去正規化用）；缺年級一律拒絕 */
function studentIdentityOf(session: VerifiedSession): StudentIdentity | null {
  const entry = session.__entry;
  const grade = entry && typeof entry.grade === "string" ? entry.grade : "";
  if (!grade) return null;
  const classCode = entry && typeof entry.classCode === "string" ? entry.classCode : "";
  const name =
    entry && typeof entry.name === "string" && entry.name
      ? entry.name
      : session.displayName || session.account;
  const studentId = entry && typeof entry.studentId === "string" ? entry.studentId : "";
  const seatNo = entry && typeof entry.seatNo === "string" ? entry.seatNo : "";
  const className = entry && typeof entry.className === "string" ? entry.className : "";
  const rollNo = entry && typeof entry.rollNo === "string" ? entry.rollNo : "";
  return { uid: session.uid, name, grade, classCode, studentId, seatNo, className, rollNo };
}

/** GET：本人可見場次（已依對象過濾）＋我的登錄科目 */
export async function GET(request: NextRequest) {
  try {
    const limited = enforceRateLimit(
      request,
      "exam-registration-list",
      RATE.EXAM_REGISTRATION_LIST.limit,
      RATE.EXAM_REGISTRATION_LIST.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    // P4 啟用閘：模組停用後學生端 API 一併停用（超級 bypass 由宿主處理；管理端刻意不接——停用時仍需配置）
    const gate = await requireFeatureModuleEnabled("examRegistration", session);
    if (gate) return gate;

    const student = studentIdentityOf(session as VerifiedSession);
    if (!student) {
      return NextResponse.json(
        { success: false, message: "名冊缺少年級資料，請聯絡承辦" },
        { status: 403, headers: noStore }
      );
    }

    const events = await listStudentExamEvents(student);
    return NextResponse.json({ success: true, events }, { headers: noStore });
  } catch (error) {
    console.error("Exam registration GET error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "系統錯誤") },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}

/** POST：登錄／修改／不報名（`{ eventId, subjectKeys, subjectAdvancedOptionCodes?, optOut?, optOutReason?, locationCode?, nonAirConditionedRoom?, examServiceNote?, feeCode? }`） */
export async function POST(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "exam-registration-mutate",
      RATE.EXAM_REGISTRATION_MUTATE.limit,
      RATE.EXAM_REGISTRATION_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("examRegistration", session);
    if (gate) return gate;

    const student = studentIdentityOf(session as VerifiedSession);
    if (!student) {
      return NextResponse.json(
        { success: false, message: "名冊缺少年級資料，請聯絡承辦" },
        { status: 403, headers: noStore }
      );
    }

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const eventId = body && typeof body.eventId === "string" ? body.eventId : "";
    if (!eventId) {
      return NextResponse.json({ success: false, message: "缺少場次 id" }, { status: 400, headers: noStore });
    }
    const subjectKeys = body && Array.isArray(body.subjectKeys) ? body.subjectKeys : [];
    const subjectAdvancedOptionCodes =
      body && body.subjectAdvancedOptionCodes && typeof body.subjectAdvancedOptionCodes === "object"
        ? (body.subjectAdvancedOptionCodes as Record<string, unknown>)
        : undefined;
    const optOut = body?.optOut === true;
    const optOutReason = body && typeof body.optOutReason === "string" ? body.optOutReason : "";
    const locationCode = body && typeof body.locationCode === "string" ? body.locationCode : undefined;
    const nonAirConditionedRoom = body?.nonAirConditionedRoom === true;
    const examServiceNote = body && typeof body.examServiceNote === "string" ? body.examServiceNote : "";
    const feeCode = body && typeof body.feeCode === "string" ? body.feeCode : undefined;

    const { registration, created } = await upsertExamRegistration({
      eventId,
      student,
      subjectKeys,
      subjectAdvancedOptionCodes,
      optOut,
      optOutReason,
      locationCode,
      nonAirConditionedRoom,
      examServiceNote,
      feeCode,
      ip: getClientIp(request),
    });
    return NextResponse.json(
      {
        success: true,
        message: optOut ? "已記錄：不報名" : created ? "登錄完成" : "已更新你的選考科目",
        registration,
      },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Exam registration POST error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "系統錯誤") },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}

/** PATCH：封存本人資料（`{ eventId }`）——凍結唯讀，可下載報名表留存 */
export async function PATCH(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "exam-registration-mutate",
      RATE.EXAM_REGISTRATION_MUTATE.limit,
      RATE.EXAM_REGISTRATION_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("examRegistration", session);
    if (gate) return gate;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const eventId = body && typeof body.eventId === "string" ? body.eventId : "";
    if (!eventId) {
      return NextResponse.json({ success: false, message: "缺少場次 id" }, { status: 400, headers: noStore });
    }

    const { registration } = await archiveExamRegistration({
      eventId,
      studentUid: session.uid,
      ip: getClientIp(request),
    });
    return NextResponse.json(
      { success: true, message: "已封存報名資料（不可再修改）", registration },
      { headers: noStore }
    );
  } catch (error) {
    console.error("Exam registration PATCH error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "系統錯誤") },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}

/** DELETE：取消登錄（`{ eventId }`；截止後唯讀，伺服端拒絕） */
export async function DELETE(request: NextRequest) {
  try {
    const originDenied = assertSameOrigin(request);
    if (originDenied) return originDenied;

    const limited = enforceRateLimit(
      request,
      "exam-registration-mutate",
      RATE.EXAM_REGISTRATION_MUTATE.limit,
      RATE.EXAM_REGISTRATION_MUTATE.windowMs
    );
    if (limited) return limited;

    const { session, denial } = await requireRole("student");
    if (denial) return toAuthResponse(denial);

    const gate = await requireFeatureModuleEnabled("examRegistration", session);
    if (gate) return gate;

    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const eventId = body && typeof body.eventId === "string" ? body.eventId : "";
    if (!eventId) {
      return NextResponse.json({ success: false, message: "缺少場次 id" }, { status: 400, headers: noStore });
    }

    await withdrawExamRegistration({
      eventId,
      studentUid: session.uid,
      ip: getClientIp(request),
    });
    return NextResponse.json({ success: true, message: "已取消報名" }, { headers: noStore });
  } catch (error) {
    console.error("Exam registration DELETE error:", error);
    return NextResponse.json(
      { success: false, message: errorMessage(error, "系統錯誤") },
      { status: error instanceof ExamRegistrationError ? error.status : 500, headers: noStore }
    );
  }
}
