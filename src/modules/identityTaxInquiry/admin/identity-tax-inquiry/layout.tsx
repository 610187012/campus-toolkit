import AdminSectionShell from "@/components/AdminSectionShell";

export default function IdentityTaxInquiryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminSectionShell
      moduleKey="identityTaxInquiry"
      title="註冊身分與財稅查調"
      description="每學期註冊身分確認、財稅查調名冊與匯出作業。"
      deniedMessage="「註冊身分與財稅查調」未被指派給此帳號，請洽管理員在「功能模組管理」頁指派。"
    >
      {children}
    </AdminSectionShell>
  );
}
