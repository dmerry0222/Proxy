import ProxyNavigation from "@/components/ProxyNavigation";

export default function AppShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="flex min-h-screen">
        <aside className="hidden w-64 border-r border-neutral-800 bg-neutral-950 p-4 md:block">
          <div className="mb-8 px-3">
            <div className="text-lg font-semibold">Proxy</div>
            <div className="text-xs text-neutral-500">
              Chief of Staff
            </div>
          </div>

          <ProxyNavigation />
        </aside>

        <main className="min-w-0 flex-1">
          <div className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-neutral-800 bg-neutral-950/95 px-2 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        <ProxyNavigation compact />
      </div>
    </div>
  );
}
