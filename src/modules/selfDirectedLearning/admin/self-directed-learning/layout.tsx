import AdminSectionShell from "@/components/AdminSectionShell";

export default function SelfDirectedLearningLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminSectionShell
      moduleKey="selfDirectedLearning"
      title="自主學習計畫"
      description="設定送審時間、可填週數、彈性學習節次行程、開放場域、審核人員與給學生的說明。"
      deniedMessage="「自主學習計畫」未被指派給此帳號，請洽管理員在「功能模組管理」頁指派。"
    >
      {children}
    </AdminSectionShell>
  );
}
