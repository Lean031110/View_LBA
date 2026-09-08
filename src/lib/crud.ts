import { db } from "@/lib/db"
import type { SessionPayload } from "@/lib/auth"
import { notifyContentUpdate } from "@/lib/realtime"

export { pickFields, readBody } from "@/lib/fields"

export async function logAction(user: SessionPayload, action: string, section: string, details?: string) {
  await db.log
    .create({ data: { userId: user.uid, userName: user.name, action, section, details: details?.slice(0, 500) } })
    .catch(() => {})
}

export { notifyContentUpdate }
