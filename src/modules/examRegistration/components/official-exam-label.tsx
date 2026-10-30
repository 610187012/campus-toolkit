import { isOfficialEntranceExamTitle } from "../types/exam-registration";

export default function OfficialExamLabel({ title }: { title: string }) {
  if (!isOfficialEntranceExamTitle(title)) return null;

  return (
    <span className="ml-2 inline-block align-middle whitespace-nowrap rounded border border-current px-1.5 py-0.5 text-[10px] font-medium text-primary">
      正規升學考試
    </span>
  );
}
