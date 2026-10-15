import Fastify from "fastify";
import type { HistoryEntry, Ticket } from "../server/change-control/providers/zammad/api.js";

export async function fakeZammad() {
  const app = Fastify();
  const records = new Map<number, Ticket>();
  const histories = new Map<number, HistoryEntry[]>();
  const notes = new Map<number, { id: number; subject: string; body: string }[]>();
  let created = 0,
    reported = 0,
    failResult = false;
  function update(id: number, fields: Partial<Ticket>, user: number) {
    const ticket = records.get(id);
    if (!ticket) throw new Error("Missing fixture ticket");
    const history = histories.get(id) ?? [];
    for (const [attribute, value] of Object.entries(fields)) {
      const previous = ticket[attribute as keyof Ticket];
      if (previous === value) continue;
      history.push({
        id: history.length + 1,
        attribute,
        value_from: String(previous ?? ""),
        value_to: String(value),
        created_by_id: user,
        created_at: new Date().toISOString(),
      });
    }
    Object.assign(ticket, fields);
    histories.set(id, history);
    return ticket;
  }
  function decide(id: number, value: string, user: number, reason = "Scope and recovery verified") {
    update(
      id,
      {
        agentos_impact: "Lab only",
        agentos_validation: "Read back",
        agentos_rollback: "Delete lab object",
      },
      user,
    );
    update(id, { agentos_decision: value, agentos_reason: reason }, user);
  }
  app.post("/api/v1/tickets/search", async (request) => {
    const query = (
      request.body as { condition: { "ticket.agentos_change_key": { value: string } } }
    ).condition["ticket.agentos_change_key"].value;
    return [...records.values()].filter((ticket) => ticket.agentos_change_key === query);
  });
  app.post("/api/v1/tickets", async (request) => {
    const ticket = {
      ...(request.body as Ticket),
      id: ++created,
      number: String(created),
      created_by_id: 1,
      state: "open",
    };
    records.set(ticket.id, ticket);
    return ticket;
  });
  app.get<{ Params: { id: string } }>("/api/v1/tickets/:id", async (request) =>
    records.get(Number(request.params.id)),
  );
  app.get<{ Params: { id: string } }>("/api/v1/ticket_history/:id", async (request) => ({
    history: histories.get(Number(request.params.id)) ?? [],
  }));
  app.get<{ Params: { id: string } }>("/api/v1/users/:id", async (request) => {
    const id = Number(request.params.id);
    return {
      id,
      login: id === 2 ? "agentos-reviewer" : id === 3 ? "ops" : "agentos-coordinator",
      active: true,
      role_ids: [id === 2 ? 8 : id === 3 ? 7 : 1],
    };
  });
  app.put<{ Params: { id: string } }>("/api/v1/tickets/:id", async (request) =>
    update(
      Number(request.params.id),
      request.body as Partial<Ticket>,
      request.headers.authorization?.includes("reviewer") ? 2 : 1,
    ),
  );
  app.get<{ Params: { id: string } }>(
    "/api/v1/ticket_articles/by_ticket/:id",
    async (request) => notes.get(Number(request.params.id)) ?? [],
  );
  app.post("/api/v1/ticket_articles", async (request, reply) => {
    if (failResult) {
      failResult = false;
      return reply.code(503).send();
    }
    const note = request.body as { ticket_id: number; subject: string; body: string };
    const entries = notes.get(note.ticket_id) ?? [];
    const result = { id: ++reported, subject: note.subject, body: note.body };
    entries.push(result);
    notes.set(note.ticket_id, entries);
    return result;
  });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    url,
    decide,
    records,
    histories,
    created: () => created,
    reported: () => reported,
    failNextResult: () => {
      failResult = true;
    },
    close: () => app.close(),
  };
}
