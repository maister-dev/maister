"use client";

import type { ReactNode } from "react";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button, Dropdown, Modal } from "@heroui/react";
import {
  Cog6ToothIcon,
  EllipsisHorizontalIcon,
  RectangleStackIcon,
} from "@heroicons/react/24/outline";

export function ProjectMenu({
  label,
  items,
  more = false,
}: {
  label: string;
  items: Array<{ key: string; label: string; href: string }>;
  more?: boolean;
}) {
  const Icon = more ? EllipsisHorizontalIcon : Cog6ToothIcon;

  return (
    <Dropdown>
      <Dropdown.Trigger
        aria-label={label}
        className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-3 py-2 text-xs text-ink"
      >
        <Icon aria-hidden="true" className="size-4" />
        {more ? null : label}
      </Dropdown.Trigger>
      <Dropdown.Popover className="z-[210]">
        <Dropdown.Menu aria-label={label}>
          {items.map((item) => (
            <Dropdown.Item
              key={item.key}
              href={item.href}
              textValue={item.label}
            >
              {item.label}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

export function ProjectWorkspacesPanel({
  label,
  title,
  closeLabel,
  children,
}: {
  label: string;
  title: string;
  closeLabel: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  function setOpen(open: boolean) {
    const query = new URLSearchParams(searchParams.toString());

    if (open) query.set("workspaces", "open");
    else query.delete("workspaces");

    router.replace(`${pathname}${query.size ? `?${query}` : ""}`, {
      scroll: false,
    });
  }

  return (
    <Modal
      isOpen={searchParams.get("workspaces") === "open"}
      onOpenChange={setOpen}
    >
      <Button
        className="border border-line bg-paper text-xs text-ink"
        variant="secondary"
      >
        <RectangleStackIcon aria-hidden="true" className="size-4" />
        {label}
      </Button>
      <Modal.Backdrop className="z-[200]">
        <Modal.Container
          className="!fixed !inset-y-0 !right-0 !m-0 !h-dvh !max-h-dvh !w-full !max-w-lg !rounded-none"
          scroll="inside"
        >
          <Modal.Dialog className="h-full bg-paper text-ink">
            <Modal.Header>
              <Modal.Heading>{title}</Modal.Heading>
              <Modal.CloseTrigger aria-label={closeLabel} />
            </Modal.Header>
            <Modal.Body>{children}</Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
