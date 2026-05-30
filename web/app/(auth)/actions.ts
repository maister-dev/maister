"use server";

import pino from "pino";
import { z } from "zod";

import { signIn } from "@/auth";
import { isMaisterError } from "@/lib/errors";
import { registerPendingUser, verifyCredentialAccount } from "@/lib/users";

const log = pino({
  name: "action-auth",
  level: process.env.LOG_LEVEL ?? "info",
});

const registerSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(12),
});

export type RegisterError = "duplicate" | "weak" | "invalid" | "generic";
export type RegisterResult =
  | { ok: true; status: "pending" }
  | { ok: false; error: RegisterError };

export async function register(input: {
  name: string;
  email: string;
  password: string;
}): Promise<RegisterResult> {
  const parsed = registerSchema.safeParse(input);

  if (!parsed.success) {
    const weak = parsed.error.issues.some((i) => i.path[0] === "password");

    log.warn({ weak }, "register validation failed");

    return { ok: false, error: weak ? "weak" : "invalid" };
  }

  const email = parsed.data.email.toLowerCase();

  try {
    await registerPendingUser({
      name: parsed.data.name,
      email,
      password: parsed.data.password,
    });

    return { ok: true, status: "pending" };
  } catch (error) {
    if (isMaisterError(error) && error.code === "CONFLICT") {
      log.warn({ email }, "register rejected: duplicate email");

      return { ok: false, error: "duplicate" };
    }

    log.error(
      { email, err: error instanceof Error ? error.message : String(error) },
      "register failed",
    );

    return { ok: false, error: "generic" };
  }
}

export type AuthState =
  | { error: RegisterError | "pending" | "disabled" }
  | undefined;

function authErrorType(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;

  const candidate = error as Error & { type?: unknown };

  return typeof candidate.type === "string" ? candidate.type : undefined;
}

export async function authenticate(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const redirectTo = (formData.get("redirectTo") as string) || "/";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  try {
    const credentialResult = await verifyCredentialAccount({ email, password });

    if (!credentialResult.ok) {
      return { error: credentialResult.reason };
    }

    await signIn("credentials", {
      email,
      password,
      redirectTo,
    });

    return undefined;
  } catch (error) {
    const type = authErrorType(error);

    if (type) {
      log.warn({ type }, "authenticate failed");

      return {
        error: type === "CredentialsSignin" ? "invalid" : "generic",
      };
    }

    throw error;
  }
}
