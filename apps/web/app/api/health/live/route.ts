import { NextResponse } from "next/server";
import { healthResponseSchema } from "@sculpin/api-contracts";
export function GET(): NextResponse {
  return NextResponse.json(
    healthResponseSchema.parse({ status: "ok", service: "web" }),
  );
}
