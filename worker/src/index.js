const ENDPOINTS = {
  staging: 'https://admin-api.aircall-staging.com/graphql',
  prod: 'https://admin-api.aircall.io/graphql',
};

const ENV_NAME = 'prod';

const LIST_VIRTUAL_AGENTS = `
  query listVirtualAgents($companyId: ID!) {
    listVirtualAgents(companyId: $companyId) {
      items { id personality { name } language updatedAt }
    }
  }
`;

const LIST_CONVERSATIONS = `
  query listConversations($input: ListConversationsInput) {
    listConversations(input: $input) {
      items { id callId phoneNumber agentId createdAt status messages { id role } }
      size hasMore lastEvaluatedKey
    }
  }
`;

const GET_CONVERSATION = `
  query GetConversation($id: ID!) {
    getConversation(id: $id) {
      id callId phoneNumber agentId createdAt updatedAt status
      messages { id createdAt role content }
    }
  }
`;

// Lets callers paste either the AIVA conversation ID or the Twilio call ID
// (e.g. from their own call logs) into the same field.
const GET_CONVERSATION_BY_CALL_ID = `
  query GetConversationByCallId($callId: ID!) {
    getConversationByCallId(callId: $callId) {
      items {
        id callId phoneNumber agentId createdAt updatedAt status
        messages { id createdAt role content }
      }
    }
  }
`;

const GET_AUDIT_LOGS = `
  query getConversationAuditLogs($conversationId: ID!, $input: ConversationAuditLogsInput) {
    getConversationAuditLogs(conversationId: $conversationId, input: $input) {
      items { id conversationId createdAt event log }
      lastEvaluatedKey
    }
  }
`;

// Audit log stream includes a lot of low-level pipeline noise (state
// transitions, TTS/audio events, etc). Only these two events carry the
// tool-call name/arguments/result the client actually wants to see.
const TOOL_EVENTS = new Set(['function_call_received', 'function_call_response_sent']);
const MAX_AUDIT_PAGES = 10;
// Confirmed empirically (2026-10) that listConversations can hit the same
// 6MB Lambda ceiling as the audit-log endpoint, and not because any single
// conversation is huge: fetching conversations one at a time always
// succeeded, but a batch of 25 failed where a batch of 20 didn't — the
// resolver evidently assembles full conversation data for the whole
// requested page before GraphQL trims it down to the fields we asked for,
// so total page size scales with pageSize regardless of our selection set.
const CONVERSATIONS_PAGE_SIZE = 20;
const MIN_CONVERSATIONS_PAGE_SIZE = 5;
// The admin API runs on AWS Lambda, which hard-caps a single synchronous
// response at 6 MB. A page of audit-log events can blow past that if any
// event's payload is large (e.g. a knowledge-base lookup result on a
// Pinecone-backed agent) — start conservative and back off further on
// a payload-size error rather than failing the whole transcript.
const AUDIT_LOG_PAGE_SIZE = 50;
const MIN_AUDIT_LOG_PAGE_SIZE = 5;

function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

function isPayloadTooLarge(err) {
  return /payload size/i.test(err.message);
}

async function fetchConversationsPage(agentId, token, pageSize, lastEvaluatedKey) {
  const input = { agentId, pageSize };
  if (lastEvaluatedKey) input.lastEvaluatedKey = lastEvaluatedKey;
  try {
    return await gql(LIST_CONVERSATIONS, { input }, token);
  } catch (err) {
    if (isPayloadTooLarge(err) && pageSize > MIN_CONVERSATIONS_PAGE_SIZE) {
      return fetchConversationsPage(agentId, token, Math.max(MIN_CONVERSATIONS_PAGE_SIZE, Math.floor(pageSize / 2)), lastEvaluatedKey);
    }
    throw err;
  }
}

async function fetchAuditLogPage(conversationId, token, limit, lastEvaluatedKey) {
  const input = { limit };
  if (lastEvaluatedKey) input.lastEvaluatedKey = lastEvaluatedKey;
  try {
    const data = await gql(GET_AUDIT_LOGS, { conversationId, input }, token);
    return data.getConversationAuditLogs;
  } catch (err) {
    if (isPayloadTooLarge(err) && limit > MIN_AUDIT_LOG_PAGE_SIZE) {
      return fetchAuditLogPage(conversationId, token, Math.max(MIN_AUDIT_LOG_PAGE_SIZE, Math.floor(limit / 4)), lastEvaluatedKey);
    }
    throw err;
  }
}

// Returns { events, truncated }. `truncated` means a page still exceeded
// the payload limit even at the smallest page size — we stop there rather
// than erroring out, so the caller still gets the tool calls gathered so
// far (audit events arrive newest-first, so these are the most recent ones).
async function fetchAllToolCallEvents(conversationId, token) {
  const events = [];
  let lastEvaluatedKey = null;
  let truncated = false;

  for (let page = 0; page < MAX_AUDIT_PAGES; page++) {
    let result;
    try {
      result = await fetchAuditLogPage(conversationId, token, AUDIT_LOG_PAGE_SIZE, lastEvaluatedKey);
    } catch (err) {
      if (!isPayloadTooLarge(err)) throw err;
      truncated = true;
      break;
    }

    for (const item of result.items) {
      if (TOOL_EVENTS.has(item.event)) events.push(item);
    }

    lastEvaluatedKey = result.lastEvaluatedKey;
    if (!lastEvaluatedKey) break;
  }

  return { events, truncated };
}

function pairToolCalls(events) {
  const byId = new Map();

  for (const item of events) {
    const log = tryParse(item.log);

    if (item.event === 'function_call_received') {
      for (const fn of log.functions || []) {
        // Events arrive newest-first, so the response for this call may
        // already have been processed — merge rather than overwrite.
        const existing = byId.get(fn.id) || {};
        byId.set(fn.id, {
          ...existing,
          id: fn.id,
          name: fn.name,
          arguments: tryParse(fn.arguments),
          requestedAt: item.createdAt,
        });
      }
    } else if (item.event === 'function_call_response_sent') {
      const existing = byId.get(log.id) || { id: log.id, name: log.name };
      byId.set(log.id, {
        ...existing,
        name: existing.name || log.name,
        outcome: log.outcome,
        result: tryParse(log.content),
        respondedAt: item.createdAt,
      });
    }
  }

  return [...byId.values()];
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Access-Code',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

async function getValidToken(env) {
  const raw = await env.TOKENS.get(ENV_NAME);
  if (!raw) {
    throw new Error('No cached token in KV. Seed it with `wrangler kv key put`.');
  }
  let data = JSON.parse(raw);

  const isExpired = Date.now() >= data.expires_at - 60_000;
  if (isExpired) {
    const resp = await fetch(`https://${data.domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: data.client_id,
        refresh_token: data.refresh_token,
      }).toString(),
    });
    if (!resp.ok) {
      throw new Error(`Token refresh failed: ${await resp.text()}`);
    }
    const tokens = await resp.json();
    data = {
      ...data,
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || data.refresh_token,
      expires_at: Date.now() + tokens.expires_in * 1000,
    };
    await env.TOKENS.put(ENV_NAME, JSON.stringify(data));
  }

  // staging uses id_token, prod uses access_token (mirrors get-admin-portal-token.mjs)
  return data.env === 'prod' ? data.access_token : data.id_token;
}

async function gql(query, variables, token) {
  const resp = await fetch(ENDPOINTS[ENV_NAME], {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const result = await resp.json();
  if (result.errors) {
    throw new Error(result.errors.map((e) => e.message).join('; '));
  }
  return result.data;
}

// The single source of truth for "which agents belong to this deployment's
// company". Every other endpoint checks membership against this list rather
// than trusting a per-agent lookup to have scoped itself correctly.
async function getAllowedAgents(env, token) {
  const data = await gql(LIST_VIRTUAL_AGENTS, { companyId: env.COMPANY_ID }, token);
  const items = data.listVirtualAgents.items || [];
  return new Map(items.map((a) => [a.id, { name: a.personality?.name || '(unnamed agent)', language: a.language, updatedAt: a.updatedAt }]));
}

async function resolveConversation(idOrCallId, token) {
  try {
    const byId = await gql(GET_CONVERSATION, { id: idOrCallId }, token);
    if (byId.getConversation) return byId.getConversation;
  } catch {
    // Not a valid conversation ID (e.g. a Twilio call ID was passed instead) — fall through.
  }

  const byCallId = await gql(GET_CONVERSATION_BY_CALL_ID, { callId: idOrCallId }, token);
  return byCallId.getConversationByCallId.items[0] || null;
}

async function handleListAgents(env, origin) {
  const token = await getValidToken(env);
  const allowed = await getAllowedAgents(env, token);
  const agents = [...allowed.entries()].map(([id, info]) => ({ id, ...info }));
  return jsonResponse({ agents }, 200, origin);
}

async function handleListConversations(url, env, origin) {
  const agentId = url.searchParams.get('agentId');
  if (!agentId) {
    return jsonResponse({ error: 'Missing agentId query param' }, 400, origin);
  }

  const token = await getValidToken(env);
  const allowed = await getAllowedAgents(env, token);
  if (!allowed.has(agentId)) {
    return jsonResponse({ error: 'Agent is outside the allowed company scope' }, 403, origin);
  }

  const after = url.searchParams.get('after') || undefined;
  const data = await fetchConversationsPage(agentId, token, CONVERSATIONS_PAGE_SIZE, after);
  const items = (data.listConversations.items || [])
    .filter((c) => c.agentId === agentId)
    .map((c) => ({
      id: c.id,
      callId: c.callId,
      phoneNumber: c.phoneNumber,
      createdAt: c.createdAt,
      status: c.status,
      messageCount: (c.messages || []).length,
    }));

  return jsonResponse(
    {
      agentName: allowed.get(agentId).name,
      conversations: items,
      hasMore: data.listConversations.hasMore,
      nextCursor: data.listConversations.lastEvaluatedKey || null,
    },
    200,
    origin
  );
}

async function handleGetConversation(url, env, origin) {
  const conversationId = url.searchParams.get('conversationId');
  if (!conversationId) {
    return jsonResponse({ error: 'Missing conversationId query param' }, 400, origin);
  }

  const token = await getValidToken(env);

  const conversation = await resolveConversation(conversationId, token);
  if (!conversation) {
    return jsonResponse({ error: 'Conversation not found' }, 404, origin);
  }

  const allowed = await getAllowedAgents(env, token);
  if (!allowed.has(conversation.agentId)) {
    return jsonResponse({ error: 'Conversation is outside the allowed company scope' }, 403, origin);
  }

  // Only keep actual conversation turns: drop the system prompt and the
  // raw "tool" role stub message (its content is superseded by the
  // richer paired tool-call data below).
  const messages = conversation.messages.filter((m) => m.role === 'user' || m.role === 'assistant');

  const { events: toolEvents, truncated } = await fetchAllToolCallEvents(conversation.id, token);
  const toolCalls = pairToolCalls(toolEvents);

  return jsonResponse(
    {
      conversation: { ...conversation, messages },
      toolCalls,
      toolCallsTruncated: truncated,
    },
    200,
    origin
  );
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '*';

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // Access code must come from the header only — never accept it as a
    // query param, so it never ends up in browser history, server logs, or
    // a shared link.
    const providedCode = request.headers.get('X-Access-Code');
    if (!env.ACCESS_CODE || providedCode !== env.ACCESS_CODE) {
      return jsonResponse({ error: 'Unauthorized' }, 401, origin);
    }

    const url = new URL(request.url);
    const view = url.searchParams.get('view');

    try {
      if (view === 'agents') return await handleListAgents(env, origin);
      if (view === 'conversations') return await handleListConversations(url, env, origin);
      return await handleGetConversation(url, env, origin);
    } catch (err) {
      return jsonResponse({ error: err.message }, 500, origin);
    }
  },
};
