import { Code, ConnectError } from "@connectrpc/connect";

export interface Ticket {
  id: number;
  number: string;
  title: string;
  state_id: number;
  state: string;
  created_by_id: number;
  agentos_change_key: string;
  agentos_plan_hash: string;
  agentos_proposal: string;
  agentos_change_type: string;
  agentos_impact: string;
  agentos_validation: string;
  agentos_rollback: string;
  agentos_simulation: string;
  agentos_decision: string;
  agentos_reason: string;
}

export interface HistoryEntry {
  id: number;
  attribute: string;
  value_from: string;
  value_to: string;
  created_by_id: number;
  created_at: string;
}

export interface TicketHistory {
  history: HistoryEntry[];
}

export interface ZammadUser {
  id: number;
  login: string;
  active: boolean;
  role_ids: number[];
}

/** Adapter for the upstream REST API; credentials never enter an engineer session. */
export class Zammad {
  constructor(
    private url: string,
    private token: string,
  ) {}

  async request<T>(path: string, method = "GET", body?: object): Promise<T> {
    const response = await fetch(`${this.url}/api/v1/${path}`, {
      method,
      headers: { Authorization: `Token token=${this.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new ConnectError(
        `Zammad ${method} ${path.split("?")[0]}: ${response.status}`,
        Code.Unavailable,
      );
    return response.json() as Promise<T>;
  }

  ticket(id: string | number) {
    return this.request<Ticket>(`tickets/${id}?expand=true`);
  }
  history(id: string | number) {
    return this.request<TicketHistory>(`ticket_history/${id}`);
  }
  user(id: number) {
    return this.request<ZammadUser>(`users/${id}`);
  }
  update(id: string | number, fields: object) {
    return this.request<Ticket>(`tickets/${id}`, "PUT", fields);
  }
  create(fields: object) {
    return this.request<Ticket>("tickets", "POST", fields);
  }
  articles(id: string | number) {
    return this.request<{ id: number; subject: string; body: string; message_id?: string }[]>(
      `ticket_articles/by_ticket/${id}`,
    );
  }
  async find(changeId: string) {
    const result = await this.request<Ticket[]>("tickets/search", "POST", {
      condition: { "ticket.agentos_change_key": { operator: "is", value: changeId } },
      limit: 2,
    });
    if (result.length > 1)
      throw new ConnectError(
        "Multiple tickets match the registered operation",
        Code.FailedPrecondition,
      );
    return result.find((ticket) => ticket.agentos_change_key === changeId);
  }
}
