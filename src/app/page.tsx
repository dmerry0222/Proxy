import QuickIntake from "@/components/ingestion/QuickIntake";

export default function HomePage() {
  return (
    <div className="space-y-8">
      <header>
        <div className="text-sm text-neutral-500">
          Chief of Staff
        </div>

        <h1 className="mt-1 text-3xl font-semibold">
          Good evening.
        </h1>

        <p className="mt-2 max-w-2xl text-neutral-400">
          Proxy will eventually surface what matters, protect time for the
          work, and keep track of the context around it.
        </p>
      </header>

      <section className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
        <div className="text-sm font-medium text-neutral-300">
          Ask Proxy
        </div>

        <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-neutral-600">
          Chat with your Chief of Staff…
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <section className="rounded-xl border border-neutral-800 p-5">
          <div className="text-sm font-medium">
            Mailroom
          </div>

          <p className="mt-2 text-sm text-neutral-500">
            Inbox triage and proposed actions will appear here.
          </p>
        </section>

        <section className="rounded-xl border border-neutral-800 p-5">
          <div className="text-sm font-medium">
            Execute
          </div>

          <p className="mt-2 text-sm text-neutral-500">
            Today&apos;s work and capacity will appear here.
          </p>
        </section>

        <section className="rounded-xl border border-neutral-800 p-5">
          <div className="text-sm font-medium">
            Attention
          </div>

          <p className="mt-2 text-sm text-neutral-500">
            Proxy&apos;s questions and escalations will appear here.
          </p>
        </section>
      </div>

      <QuickIntake />
    </div>
  );
}