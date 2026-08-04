import { getDatabase } from "@sculpin/db";
import { createReadinessHandler } from "./handler";
export const GET = createReadinessHandler(process.env, getDatabase);
