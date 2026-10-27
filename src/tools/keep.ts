import { z } from "zod";
import { db } from "../db/supabase.js";
import { sendStoredFile } from "../telegram/send.js";
import { defineTool } from "./types.js";

// Documents, people, lists and notes: the things a friend remembers for you.

const LIMIT = 500;

async function countRows(table: string, userId: string): Promise<number> {
  const { count } = await db.from(table).select("*", { count: "exact", head: true }).eq("user_id", userId);
  return count ?? 0;
}

async function underLimit(table: string, userId: string): Promise<void> {
  if ((await countRows(table, userId)) >= LIMIT) throw new Error(`The user already has ${LIMIT} saved ${table}. Ask them to delete some first.`);
}

const fail = (tool: string, error: { message: string } | null) => {
  if (error) throw new Error(`${tool}: ${error.message}`);
};

// Documents

export const saveDocument = defineTool({
  name: "save_document",
  description:
    "Keep a file the user just sent (photo, PDF, video or voice note) so they can ask for it later, " +
    'for example "save this as my CV" or "keep my NIN slip". Give it a short name they would ask for.',
  sensitive: false,
  schema: z.object({
    name: z.string().min(1).max(80).describe('What they will call it, for example "CV" or "TV receipt".'),
    description: z.string().max(300).optional(),
  }),
  async run({ name, description }, { user, files }) {
    const file = files?.at(-1);
    if (!file) throw new Error("There is no file in this message to save. Ask the user to send it.");
    await underLimit("documents", user.id);
    const { error } = await db.from("documents").insert({
      user_id: user.id,
      name: name.trim(),
      description: description ?? null,
      kind: file.kind,
      file_id: file.fileId,
      mime_type: file.mimeType,
    });
    fail("save_document", error);
    return { message: `Saved "${name}". The user can ask for it any time.` };
  },
});

export const sendDocument = defineTool({
  name: "send_saved_document",
  description: "Send back a file the user saved earlier. Find it with list_documents if the name is not exact.",
  sensitive: false,
  schema: z.object({ name: z.string().min(1).max(80) }),
  async run({ name }, { user }) {
    const { data, error } = await db
      .from("documents")
      .select("name, kind, file_id")
      .eq("user_id", user.id)
      .ilike("name", `%${name.replace(/[%_]/g, "")}%`)
      .order("created_at", { ascending: false })
      .limit(1);
    fail("send_saved_document", error);
    const doc = data?.[0];
    if (!doc) throw new Error(`No saved file matches "${name}". Use list_documents.`);
    await sendStoredFile(user.chat_id, doc.kind, doc.file_id, doc.name);
    return { message: `Sent "${doc.name}" to the user. Do not describe the file again.` };
  },
});

export const listDocuments = defineTool({
  name: "list_documents",
  description: "List the files the user has saved.",
  sensitive: false,
  schema: z.object({}),
  async run(_args, { user }) {
    const { data, error } = await db.from("documents").select("name, description, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
    fail("list_documents", error);
    if (!data?.length) return { message: "The user has not saved any files." };
    return { message: data.map((d) => `- ${d.name}${d.description ? `: ${d.description}` : ""} (saved ${d.created_at.slice(0, 10)})`).join("\n") };
  },
});

export const deleteDocument = defineTool({
  name: "delete_document",
  description: "Delete a saved file when the user asks.",
  sensitive: false,
  schema: z.object({ name: z.string().min(1).max(80) }),
  async run({ name }, { user }) {
    const { error, count } = await db.from("documents").delete({ count: "exact" }).eq("user_id", user.id).ilike("name", name.replace(/[%_]/g, ""));
    fail("delete_document", error);
    return { message: count ? `Deleted "${name}".` : `No saved file is called "${name}". Use list_documents.` };
  },
});

// People

const BIRTHDAY = /^(\d{4}-)?\d{2}-\d{2}$/;

/** A yearly reminder at 8am on the birthday. Changing the birthday replaces the old reminder. */
async function setBirthdayReminder(userId: string, personId: string, name: string, birthday: string): Promise<string> {
  const source = `birthday:${personId}`;
  await db.from("reminders").update({ status: "cancelled" }).eq("user_id", userId).eq("source", source).eq("status", "active");
  const mmdd = birthday.slice(-5);
  const now = new Date();
  const year = now.getUTCFullYear();
  const lagosToday = new Date(now.getTime() + 3_600_000).toISOString().slice(5, 10);
  // This year's date if it is still ahead, otherwise next year's. A 29 February birthday is marked on the 28th.
  const day = mmdd === "02-29" ? "02-28" : mmdd;
  const when = `${mmdd > lagosToday ? year : year + 1}-${day}T08:00`;
  const due = new Date(Date.UTC(Number(when.slice(0, 4)), Number(when.slice(5, 7)) - 1, Number(when.slice(8, 10)), 7, 0));
  const { error } = await db.from("reminders").insert({
    user_id: userId,
    text: `${name}'s birthday today. Want me to draft a message for them?`,
    due_at: due.toISOString(),
    repeat: { every: "year" },
    source,
  });
  fail("birthday reminder", error);
  return when.slice(0, 10);
}

export const savePerson = defineTool({
  name: "save_person",
  description:
    "Save or update someone in the user's life: name, how they know them, phone, email, birthday, notes. " +
    "Use it without being asked when the user mentions these details. A birthday also sets a yearly reminder.",
  sensitive: false,
  schema: z.object({
    name: z.string().min(1).max(80),
    relation: z.string().max(80).optional().describe('For example "landlord", "sister", "customer".'),
    phone: z.string().max(30).optional(),
    email: z.string().email().optional(),
    birthday: z.string().regex(BIRTHDAY).optional().describe("MM-DD, or YYYY-MM-DD when the year is known."),
    notes: z.string().max(500).optional(),
  }),
  async run(args, { user }) {
    const name = args.name.trim();
    const { data: existing } = await db.from("people").select("id").eq("user_id", user.id).ilike("name", name).maybeSingle();
    if (!existing) await underLimit("people", user.id);
    const fields = Object.fromEntries(
      Object.entries({ relation: args.relation, phone: args.phone, email: args.email, birthday: args.birthday, notes: args.notes }).filter(([, v]) => v !== undefined),
    );
    const { data, error } = existing
      ? await db.from("people").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", existing.id).select("id").single()
      : await db.from("people").insert({ user_id: user.id, name, ...fields }).select("id").single();
    fail("save_person", error);
    const next = args.birthday ? await setBirthdayReminder(user.id, data!.id, name, args.birthday) : null;
    return { message: `Saved ${name}.${next ? ` Birthday reminder set for ${next}, then every year.` : ""}` };
  },
});

export const findPeople = defineTool({
  name: "find_people",
  description: "Look up people the user saved, by name, relation or any detail. Leave query empty to list everyone.",
  sensitive: false,
  schema: z.object({ query: z.string().max(80).optional() }),
  async run({ query }, { user }) {
    let q = db.from("people").select("name, relation, phone, email, birthday, notes").eq("user_id", user.id).order("name").limit(50);
    const term = query?.replace(/[%_,()]/g, "").trim();
    if (term) q = q.or(`name.ilike.%${term}%,relation.ilike.%${term}%,notes.ilike.%${term}%`);
    const { data, error } = await q;
    fail("find_people", error);
    if (!data?.length) return { message: term ? `Nobody saved matches "${term}".` : "The user has not saved anyone yet." };
    return {
      message: data
        .map((p) => [p.name, p.relation, p.phone, p.email, p.birthday && `birthday ${p.birthday}`, p.notes].filter(Boolean).join(", "))
        .map((l) => `- ${l}`)
        .join("\n"),
    };
  },
});

export const deletePerson = defineTool({
  name: "delete_person",
  description: "Delete someone the user saved, and their birthday reminder.",
  sensitive: false,
  schema: z.object({ name: z.string().min(1).max(80) }),
  async run({ name }, { user }) {
    const { data } = await db.from("people").select("id, name").eq("user_id", user.id).ilike("name", name.trim()).maybeSingle();
    if (!data) return { message: `Nobody is saved as "${name}". Use find_people.` };
    await db.from("reminders").update({ status: "cancelled" }).eq("user_id", user.id).eq("source", `birthday:${data.id}`);
    const { error } = await db.from("people").delete().eq("id", data.id);
    fail("delete_person", error);
    return { message: `Deleted ${data.name}.` };
  },
});

// Lists

const listName = (name: string) => name.trim().toLowerCase().replace(/\s+list$/, "") || "shopping";

async function getList(userId: string, name: string): Promise<string[]> {
  const { data } = await db.from("lists").select("items").eq("user_id", userId).eq("name", name).maybeSingle();
  return (data?.items as string[] | undefined) ?? [];
}

async function putList(userId: string, name: string, items: string[]): Promise<void> {
  const { error } = await db.from("lists").upsert({ user_id: userId, name, items, updated_at: new Date().toISOString() }, { onConflict: "user_id,name" });
  fail("lists", error);
}

const showItems = (name: string, items: string[]) => (items.length ? `${name} list:\n${items.map((i) => `- ${i}`).join("\n")}` : `The ${name} list is empty.`);

export const addToList = defineTool({
  name: "add_to_list",
  description: 'Add items to a list, such as the shopping list or a to-do list. "Add bread and eggs" means the shopping list.',
  sensitive: false,
  schema: z.object({ list: z.string().max(40).describe('For example "shopping", "to-do", "packing".'), items: z.array(z.string().min(1).max(120)).min(1).max(50) }),
  async run({ list, items }, { user }) {
    const name = listName(list);
    const current = await getList(user.id, name);
    const lower = new Set(current.map((i) => i.toLowerCase()));
    const next = [...current, ...items.map((i) => i.trim()).filter((i) => !lower.has(i.toLowerCase()))].slice(0, 200);
    await putList(user.id, name, next);
    return { message: `Added. ${showItems(name, next)}` };
  },
});

export const removeFromList = defineTool({
  name: "remove_from_list",
  description: 'Remove items from a list, for example when the user says they bought something or finished a task. "clear" empties it.',
  sensitive: false,
  schema: z.object({ list: z.string().max(40), items: z.array(z.string().min(1).max(120)).max(50).optional(), clear: z.boolean().optional() }),
  async run({ list, items, clear }, { user }) {
    const name = listName(list);
    const remove = new Set((items ?? []).map((i) => i.trim().toLowerCase()));
    const next = clear ? [] : (await getList(user.id, name)).filter((i) => !remove.has(i.toLowerCase()));
    await putList(user.id, name, next);
    return { message: clear ? `Cleared the ${name} list.` : `Updated. ${showItems(name, next)}` };
  },
});

export const showList = defineTool({
  name: "show_list",
  description: "Show a list, or all list names when no list is given.",
  sensitive: false,
  schema: z.object({ list: z.string().max(40).optional() }),
  async run({ list }, { user }) {
    if (list) return { message: showItems(listName(list), await getList(user.id, listName(list))) };
    const { data } = await db.from("lists").select("name, items").eq("user_id", user.id);
    if (!data?.length) return { message: "The user has no lists yet." };
    return { message: data.map((l) => `- ${l.name} (${(l.items as string[]).length} items)`).join("\n") };
  },
});

// Notes

export const saveNote = defineTool({
  name: "save_note",
  description: "Save a note or idea, often from a voice note. Tidy it into clear text first, keeping all the details.",
  sensitive: false,
  schema: z.object({
    title: z.string().min(1).max(100),
    body: z.string().min(1).max(5000),
    topic: z.string().max(40).optional().describe('A one or two word topic such as "business ideas" or "school".'),
  }),
  async run({ title, body, topic }, { user }) {
    await underLimit("notes", user.id);
    const { error } = await db.from("notes").insert({ user_id: user.id, title: title.trim(), body: body.trim(), topic: topic?.trim().toLowerCase() ?? null });
    fail("save_note", error);
    return { message: `Saved the note "${title}".` };
  },
});

export const findNotes = defineTool({
  name: "find_notes",
  description: "Find the user's notes by words in the title, text or topic. Leave query empty for the latest notes.",
  sensitive: false,
  schema: z.object({ query: z.string().max(80).optional() }),
  async run({ query }, { user }) {
    let q = db.from("notes").select("title, body, topic, created_at").eq("user_id", user.id).order("created_at", { ascending: false }).limit(10);
    const term = query?.replace(/[%_,()]/g, "").trim();
    if (term) q = q.or(`title.ilike.%${term}%,body.ilike.%${term}%,topic.ilike.%${term}%`);
    const { data, error } = await q;
    fail("find_notes", error);
    if (!data?.length) return { message: term ? `No notes match "${term}".` : "The user has no notes yet." };
    return { message: data.map((n) => `- ${n.title} (${n.created_at.slice(0, 10)}${n.topic ? `, ${n.topic}` : ""}): ${n.body}`).join("\n") };
  },
});

export const deleteNote = defineTool({
  name: "delete_note",
  description: "Delete a note by its title when the user asks.",
  sensitive: false,
  schema: z.object({ title: z.string().min(1).max(100) }),
  async run({ title }, { user }) {
    const { error, count } = await db.from("notes").delete({ count: "exact" }).eq("user_id", user.id).ilike("title", title.trim().replace(/[%_]/g, ""));
    fail("delete_note", error);
    return { message: count ? `Deleted the note "${title}".` : `No note is called "${title}". Use find_notes.` };
  },
});

// Everything

export const whatIKnow = defineTool({
  name: "what_i_know",
  description:
    'Everything MyPaddy has saved about the user, for "what do you know about me?". ' +
    "Show it plainly and tell them they can ask you to delete anything.",
  sensitive: false,
  schema: z.object({}),
  async run(_args, { user }) {
    const [memory, people, docs, lists, notes, reminders] = await Promise.all([
      db.from("memory").select("key, value").eq("user_id", user.id),
      db.from("people").select("name, relation").eq("user_id", user.id).order("name").limit(100),
      db.from("documents").select("name").eq("user_id", user.id).limit(100),
      db.from("lists").select("name, items").eq("user_id", user.id),
      db.from("notes").select("title").eq("user_id", user.id).order("created_at", { ascending: false }).limit(20),
      db.from("reminders").select("id", { count: "exact", head: true }).eq("user_id", user.id).eq("status", "active"),
    ]);
    const lines = [
      `Name: ${user.preferred_name ?? user.name ?? "not given"}${user.types.length ? `, ${user.types.join(", ")}` : ""}`,
      `Facts: ${(memory.data ?? []).map((m) => `${m.key} = ${m.value}`).join("; ") || "none"}`,
      `People: ${(people.data ?? []).map((p) => (p.relation ? `${p.name} (${p.relation})` : p.name)).join(", ") || "none"}`,
      `Saved files: ${(docs.data ?? []).map((d) => d.name).join(", ") || "none"}`,
      `Lists: ${(lists.data ?? []).map((l) => `${l.name} (${(l.items as string[]).length})`).join(", ") || "none"}`,
      `Notes: ${(notes.data ?? []).map((n) => n.title).join(", ") || "none"}`,
      `Active reminders: ${reminders.count ?? 0}`,
      `Morning brief: ${user.brief_time ?? "off"}`,
    ];
    return { message: lines.join("\n") };
  },
});

export const keepTools = [
  saveDocument,
  sendDocument,
  listDocuments,
  deleteDocument,
  savePerson,
  findPeople,
  deletePerson,
  addToList,
  removeFromList,
  showList,
  saveNote,
  findNotes,
  deleteNote,
  whatIKnow,
];
