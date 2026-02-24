import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const GRAPHQL_URL = 'https://api.github.com/graphql';
const NOTIFICATIONS_URL = 'https://api.github.com/notifications';

// Promisify Soup3 once at module load
Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const PR_QUERY = `query {
  viewer {
    pullRequests(first: 100, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number
        title
        url
        isDraft
        updatedAt
        repository { name, owner { login } }
        reviewDecision
        reviews(last: 10) { nodes { state, author { login } } }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 30) {
                  nodes {
                    ... on CheckRun { name, status, conclusion, detailsUrl }
                    ... on StatusContext { context, state, targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Normalize a single PR node from the GraphQL response into a flat object.
 */
function normalizePR(node) {
    const commit = node.commits?.nodes?.[0]?.commit;
    const rollup = commit?.statusCheckRollup;

    const checks = (rollup?.contexts?.nodes ?? []).map(ctx => {
        // CheckRun
        if ('conclusion' in ctx) {
            return {
                name: ctx.name,
                status: ctx.status === 'COMPLETED'
                    ? (ctx.conclusion === 'SUCCESS' ? 'success' : 'failure')
                    : 'pending',
                url: ctx.detailsUrl,
            };
        }
        // StatusContext
        return {
            name: ctx.context,
            status: ctx.state === 'SUCCESS' ? 'success'
                : ctx.state === 'FAILURE' || ctx.state === 'ERROR' ? 'failure'
                : 'pending',
            url: ctx.targetUrl,
        };
    });

    // Deduplicate reviews: keep latest per author
    const reviewMap = new Map();
    for (const r of (node.reviews?.nodes ?? [])) {
        if (r.author?.login)
            reviewMap.set(r.author.login, r.state);
    }
    const reviewers = [...reviewMap.entries()].map(([login, state]) => ({login, state}));

    // Overall CI status
    let ciStatus = 'none';
    if (rollup) {
        const s = rollup.state;
        ciStatus = s === 'SUCCESS' ? 'success'
            : s === 'FAILURE' || s === 'ERROR' ? 'failure'
            : 'pending';
    }

    return {
        number: node.number,
        title: node.title,
        url: node.url,
        isDraft: node.isDraft,
        updatedAt: node.updatedAt,
        repo: `${node.repository.owner.login}/${node.repository.name}`,
        repoName: node.repository.name,
        reviewDecision: node.reviewDecision, // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null
        reviewers,
        ciStatus,
        checks,
    };
}

/**
 * Categorize an array of normalized PRs into buckets.
 */
function categorizePRs(prs) {
    const categories = {
        approved: [],
        changesRequested: [],
        reviewRequired: [],
        draft: [],
    };

    for (const pr of prs) {
        if (pr.isDraft) {
            categories.draft.push(pr);
        } else if (pr.reviewDecision === 'APPROVED') {
            categories.approved.push(pr);
        } else if (pr.reviewDecision === 'CHANGES_REQUESTED') {
            categories.changesRequested.push(pr);
        } else {
            categories.reviewRequired.push(pr);
        }
    }

    return categories;
}

export default class GitHubClient {
    constructor() {
        this._session = new Soup.Session();
        this._session.set_user_agent('gnome-shell-github-pr-status/1');
        this._lastNotificationPoll = null;
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }

    /**
     * Execute a GraphQL or REST request and return parsed JSON.
     */
    async _request(url, token, {method = 'GET', body = null} = {}) {
        const message = Soup.Message.new(method, url);
        message.get_request_headers().append('Authorization', `Bearer ${token}`);
        message.get_request_headers().append('Accept', 'application/json');

        if (body) {
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(body)));
            message.set_request_body_from_bytes('application/json', bytes);
        }

        if (method === 'GET' && url.startsWith(NOTIFICATIONS_URL) && this._lastNotificationPoll) {
            message.get_request_headers().append('If-Modified-Since', this._lastNotificationPoll);
        }

        const inputStream = await this._sendAsync(message);
        const statusCode = message.get_status();

        // 304 Not Modified for notifications
        if (statusCode === 304) return null;

        if (statusCode < 200 || statusCode >= 300) {
            const errorText = new TextDecoder().decode(inputStream);
            throw new Error(`GitHub API ${statusCode}: ${errorText.slice(0, 200)}`);
        }

        // Track Last-Modified for notification polling
        if (url.startsWith(NOTIFICATIONS_URL)) {
            const lastMod = message.get_response_headers().get_one('Last-Modified');
            if (lastMod) this._lastNotificationPoll = lastMod;
        }

        const text = new TextDecoder().decode(inputStream);
        return JSON.parse(text);
    }

    async _sendAsync(message) {
        const bytes = await this._session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        return bytes.get_data();
    }

    /**
     * Fetch all open PRs for the authenticated user.
     * Returns { categories, allPRs }.
     */
    async fetchPullRequests(token) {
        const data = await this._request(GRAPHQL_URL, token, {
            method: 'POST',
            body: {query: PR_QUERY},
        });

        if (data.errors?.length) {
            throw new Error(`GraphQL error: ${data.errors[0].message}`);
        }

        const nodes = data.data?.viewer?.pullRequests?.nodes ?? [];
        const allPRs = nodes.map(normalizePR);
        const categories = categorizePRs(allPRs);

        return {categories, allPRs};
    }

    /**
     * Fetch unread notifications, optionally filtered by reason.
     * Returns the count of matching notifications.
     */
    async fetchNotifications(token, filterReasons) {
        const data = await this._request(NOTIFICATIONS_URL, token);

        // 304 - no change
        if (data === null) return -1;

        let notifications = data;
        if (filterReasons?.length) {
            notifications = notifications.filter(n => filterReasons.includes(n.reason));
        }

        return notifications.length;
    }
}
