import "server-only";

import type { Db } from "@/lib/execution-host/db";

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { requireActiveSession } from "@/lib/authz";
import { getDb } from "@/lib/db/client";
import { submitOwnerMessage } from "@/lib/librarian/admission";
import {
  readHistoryOwner,
  readReceiptAttachments,
} from "@/lib/librarian/action-history";
import { listMessages } from "@/lib/librarian/conversation";
import {
  invalidBody,
  librarianErrorResponse,
  librarianWorkRequested,
  parseSeq,
} from "@/lib/librarian/http";
import {
  assertSubjectVisible,
  librarianMessageDto,
  librarianMessageDtos,
} from "@/lib/librarian/view";

// ADR-185 (LCV-02, LCV-03, LUI-04): page back through, and send to, the
// caller's own conversation.

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const params = request.nextUrl.searchParams;
    const beforeRaw = params.get("beforeSeq");
    const beforeSeq = beforeRaw === null ? null : parseSeq(beforeRaw);
    const limitRaw = params.get("limit");
    const limit = limitRaw === null ? 50 : Number(limitRaw);

    if (beforeRaw !== null && beforeSeq === null)
      return invalidBody("beforeSeq must be a canonical decimal");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return invalidBody("limit must be an integer between 1 and 100");
    const work = librarianWorkRequested(params);
    const result = await getDb().transaction(
      async (tx) => {
        const conversation = await readHistoryOwner(tx, user.id);
        const page = await listMessages(user.id, { beforeSeq, limit }, tx);
        const messages = await librarianMessageDtos(page.messages, user.id, tx);

        return {
          historyGeneration: conversation?.historyGeneration ?? null,
          messages,
          hasMore: page.hasMore,
          ...(work
            ? {
                currentSegmentId: conversation?.currentSegmentId ?? null,
                receiptAttachments: conversation
                  ? await readReceiptAttachments(
                      tx,
                      user.id,
                      conversation,
                      messages,
                    )
                  : {},
              }
            : {}),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );

    return NextResponse.json(
      result,
      work ? { headers: { "Cache-Control": "no-store" } } : undefined,
    );
  } catch (err) {
    return librarianErrorResponse(err, "GET /api/librarian/messages");
  }
}

const subjectSchema = z
  .object({
    projectSlug: z.string().min(1).optional(),
    taskIds: z.array(z.string().guid()).max(20).optional(),
    runId: z.string().guid().optional(),
  })
  .strict();

// No `userId`, `conversationId` or owner field exists: `.strict()` refuses one.
const postSchema = z
  .object({
    clientMessageId: z.string().guid(),
    body: z.string().min(1).max(20_000),
    subject: subjectSchema.optional(),
  })
  .strict();

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireActiveSession();
    const parsed = postSchema.safeParse(await request.json().catch(() => null));

    if (!parsed.success)
      return invalidBody(
        parsed.error.issues[0]?.message ?? "invalid message body",
      );
    const db = getDb() as unknown as Db;
    const subject = parsed.data.subject ?? null;

    await assertSubjectVisible(user.id, subject, db);
    const result = await submitOwnerMessage(
      user.id,
      {
        clientMessageId: parsed.data.clientMessageId,
        body: parsed.data.body,
        subject,
      },
      { db },
    );

    return NextResponse.json(
      { message: librarianMessageDto(result.message), turn: result.turn },
      { status: result.deduped ? 200 : 202 },
    );
  } catch (err) {
    return librarianErrorResponse(err, "POST /api/librarian/messages");
  }
}
