import { z } from "zod";

/** PostgreSQL text/JSONB cannot retain NUL or unpaired UTF-16 surrogates. No byte normalization is performed. */
export const postgresTextSchema = z
  .string()
  .regex(
    /^(?:[^\u0000\uD800-\uDFFF]|[\uD800-\uDBFF][\uDC00-\uDFFF])*$/,
    "Text contains unsupported Unicode or NUL",
  );
