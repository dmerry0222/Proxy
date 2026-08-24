"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House,
  Inbox,
  ListChecks,
  BrainCircuit,
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
];

export default function ProxyNavigation() {
  const pathname = usePathname();

  return (
    <nav className="space-y-1">
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
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
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