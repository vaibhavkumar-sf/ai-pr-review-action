import * as core from '@actions/core';
import { ActionConfig, JiraContext } from '../types';

export async function gatherJiraContext(
  config: ActionConfig,
  branchName: string,
  prTitle: string,
  prBody: string,
): Promise<JiraContext | null> {
  try {
    // 1. Check if JIRA is configured — all three must be non-empty
    if (!config.jiraUrl || !config.jiraEmail || !config.jiraApiToken) {
      return null;
    }

    // 2. Extract JIRA ticket ID
    const ticketId = extractTicketId(branchName, prTitle, prBody, config.jiraProjectKey);
    if (!ticketId) {
      core.info('No JIRA ticket ID found in branch name, PR title, or PR body');
      return null;
    }

    core.info(`Found JIRA ticket: ${ticketId}`);

    // 3. Fetch ticket from JIRA REST API v2 with field names expansion
    const jiraUrl = config.jiraUrl.replace(/\/+$/, '');
    const authString = Buffer.from(`${config.jiraEmail}:${config.jiraApiToken}`).toString('base64');

    const response = await fetch(
      `${jiraUrl}/rest/api/2/issue/${ticketId}?expand=names`,
      {
        method: 'GET',
        headers: {
          Authorization: `Basic ${authString}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response.ok) {
      core.warning(
        `JIRA API returned ${response.status} ${response.statusText} for ticket ${ticketId}`,
      );
      return null;
    }

    const issue = (await response.json()) as {
      key?: string;
      fields?: Record<string, unknown>;
      names?: Record<string, string>;
    };

    // 4. Extract standard fields
    const fields = (issue.fields ?? {}) as Record<string, unknown>;
    const names: Record<string, string> = issue.names ?? {};
    const key: string = issue.key ?? ticketId;
    const summary: string = (fields.summary as string) ?? '';
    const description: string = convertAdfToPlainText(fields.description);
    const status: string = (fields.status as { name?: string } | undefined)?.name ?? 'Unknown';
    const type: string = (fields.issuetype as { name?: string } | undefined)?.name ?? 'Unknown';
    const priority: string = (fields.priority as { name?: string } | undefined)?.name ?? 'Unknown';

    // 5. Look for acceptance criteria in custom fields using the names map
    const acceptanceCriteria = findAcceptanceCriteria(fields, names);

    // 6. Build and return JiraContext
    const jiraContext: JiraContext = {
      ticketId: key,
      ticketUrl: `${jiraUrl}/browse/${key}`,
      summary,
      description,
      status,
      type,
      priority,
    };

    if (acceptanceCriteria) {
      jiraContext.acceptanceCriteria = acceptanceCriteria;
    }

    core.info(`Successfully fetched JIRA context for ${key} (${status})`);
    return jiraContext;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    core.warning(`JIRA integration error: ${message}. Continuing without JIRA context.`);
    return null;
  }
}

/**
 * Extract JIRA ticket ID from multiple sources.
 * Checks branch name first, then PR title, then PR body.
 * If a project key is configured, prefer matches with that prefix.
 */
function extractTicketId(
  branchName: string,
  prTitle: string,
  prBody: string,
  projectKey: string,
): string | null {
  const ticketPattern = /([A-Z]{2,10}-\d+)/g;
  const sources = [branchName, prTitle, prBody];

  // If project key is set, first try to find a match with that prefix
  if (projectKey) {
    const projectPattern = new RegExp(`(${escapeRegExp(projectKey)}-\\d+)`, 'g');
    for (const source of sources) {
      const match = source.match(projectPattern);
      if (match) {
        return match[0];
      }
    }
  }

  // Fall back to generic pattern across all sources in order
  for (const source of sources) {
    const match = source.match(ticketPattern);
    if (match) {
      return match[0];
    }
  }

  return null;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert Atlassian Document Format (ADF) or plain text description to plain text.
 * Handles both JIRA Cloud (ADF) and JIRA Server (wiki markup/plain text) formats.
 */
function convertAdfToPlainText(description: unknown): string {
  if (!description) {
    return '';
  }

  // If it's already a string (JIRA Server or older Cloud), return as-is
  if (typeof description === 'string') {
    return description;
  }

  // ADF is a JSON object with type: "doc" and a content array
  if (typeof description === 'object' && description !== null) {
    const doc = description as AdfNode;
    if (doc.type === 'doc' && Array.isArray(doc.content)) {
      return extractTextFromAdfNodes(doc.content).trim();
    }
  }

  return String(description);
}

interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
}

function extractTextFromAdfNodes(nodes: AdfNode[]): string {
  const parts: string[] = [];

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        parts.push(node.text ?? '');
        break;
      case 'paragraph':
        parts.push(extractTextFromAdfNodes(node.content ?? []) + '\n');
        break;
      case 'heading':
        parts.push(extractTextFromAdfNodes(node.content ?? []) + '\n');
        break;
      case 'bulletList':
      case 'orderedList':
        parts.push(extractTextFromAdfNodes(node.content ?? []));
        break;
      case 'listItem':
        parts.push('- ' + extractTextFromAdfNodes(node.content ?? []).trim() + '\n');
        break;
      case 'codeBlock':
        parts.push(extractTextFromAdfNodes(node.content ?? []) + '\n');
        break;
      case 'blockquote':
        parts.push(
          extractTextFromAdfNodes(node.content ?? [])
            .split('\n')
            .map((line) => '> ' + line)
            .join('\n') + '\n',
        );
        break;
      case 'hardBreak':
        parts.push('\n');
        break;
      case 'mention':
        parts.push((node.attrs?.text as string) ?? '');
        break;
      case 'table':
      case 'tableRow':
      case 'tableCell':
      case 'tableHeader':
        parts.push(extractTextFromAdfNodes(node.content ?? []) + ' ');
        break;
      default:
        if (node.content) {
          parts.push(extractTextFromAdfNodes(node.content));
        }
        break;
    }
  }

  return parts.join('');
}

/**
 * Look for acceptance criteria in JIRA custom fields.
 * Uses the `names` map (from expand=names) to identify custom fields whose
 * display name contains "acceptance criteria" (case-insensitive).
 */
function findAcceptanceCriteria(
  fields: Record<string, unknown>,
  names: Record<string, string>,
): string | undefined {
  // Build a list of custom field IDs whose display name contains "acceptance criteria"
  const acFieldIds: string[] = [];
  for (const [fieldId, displayName] of Object.entries(names)) {
    if (
      fieldId.startsWith('customfield_') &&
      displayName.toLowerCase().includes('acceptance criteria')
    ) {
      acFieldIds.push(fieldId);
    }
  }

  // Check each matched field for content
  for (const fieldId of acFieldIds) {
    const value = fields[fieldId];
    if (!value) {
      continue;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    // ADF format
    if (typeof value === 'object') {
      const text = convertAdfToPlainText(value);
      if (text.length > 0) {
        return text;
      }
    }
  }

  return undefined;
}
