/** Fetch-standard compatibility for the limited Next route APIs used here. */
export class NextRequest extends Request {
  get nextUrl() { return new URL(this.url); }
}
export const NextResponse = Response;
