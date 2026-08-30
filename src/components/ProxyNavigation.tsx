"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House,
  Inbox,
  ListChecks,
  BrainCircuit,
  Radar,
} from "lucide-react";

const navigation = [
  {
    name: "Home",
    href: "/",
    icon: House,
  },
  {
    name: "Mailroom",
    href: "/mailroom",
    icon: Inbox,
  },
  {
    name: "Execute",
    href: "/execute",
    icon: ListChecks,
  },
  {
    name: "Memory",
    href: "/memory",
    icon: BrainCircuit,
  },
  {
    name: "Inspector General",
    href: "/inspector-general",
    icon: Radar,
  },
];

export default function ProxyNavigation({ compact = false }: { compact?: boolean }) {
  const pathname = usePathname();

  return (
    <nav className={compact ? "flex items-center justify-around" : "space-y-1"}>
      {navigation.map((item) => {
        const Icon = item.icon;

        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            className={[
              "flex items-center rounded-lg text-sm transition",
              compact ? "flex-col gap-1 px-2 py-2 text-[10px]" : "gap-3 px-3 py-2",
              active
                ? "bg-neutral-900 text-neutral-100"
                : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200",
            ].join(" ")}
          >
            <Icon
              size={17}
              strokeWidth={active ? 2 : 1.7}
            />

            {item.name}
          </Link>
        );
      })}
    </nav>
  );
}
