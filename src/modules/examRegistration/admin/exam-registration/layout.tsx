import AdminSectionShell from "@/components/AdminSectionShell";

export default function ExamRegistrationLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminSectionShell
      moduleKey="examRegistration"
      title="升學考試與模擬考校內報名"
      description="校內升學考試與模擬考的選考科目登錄：建立場次與科目清單、指定對象年級班級、開放與截止。"
      deniedMessage="「升學考試與模擬考校內報名」未被指派給此帳號，請洽管理員在「功能模組管理」頁指派。"
    >
      {children}
    </AdminSectionShell>
  );
}
