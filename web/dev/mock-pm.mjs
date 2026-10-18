// A stand-in Process Manager for offline end-to-end checks. Not a tenant, and nothing
// here is tenant data: every name and id is made up.
//
// It answers the calls the app makes, in the shapes the spikes recorded, with just enough
// behaviour to exercise each outcome: an archive that lands outright, one that goes
// pending, one the tenant refuses, one that reports failure but took effect, a group held
// by a live document, one held only by an archived document (F1), a draft that goes live
// on a move, the breadcrumb, and an ownership save and publish with a SCIM directory.
// For ownership, start the app with SCIM_BASE_URL=http://localhost:<port>.
//
//   node dev/mock-pm.mjs [port]      (default 4999; sign in to http://localhost:4999/tenant)
//
// GET /tenant/_log returns every request it has seen, for asserting what was sent.
// GET /tenant/_expire kills the token the way R12 measured a dead one: 302 to the sign-in
// page from GET /Api/v1/Processes/{id} and ArchiveProcess, 401 from everything else.
// ?mode=redirects expires only the two 302 endpoints, so a run can reach them.

import http from 'node:http';

const port = Number(process.argv[2] ?? 4999);
const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ROOT = id(900), FIN = id(901), SUB = id(902), OTHER = id(903), RET = id(904), FORMS = id(905), POLICIES = id(906);
const groups = {
  [FIN]: { parent: '', title: 'Finance' },
  [SUB]: { parent: FIN, title: 'Payables' },
  [RET]: { parent: FIN, title: 'Retired' },
  [FORMS]: { parent: FIN, title: 'Forms' },
  [POLICIES]: { parent: FIN, title: 'Policies' },
  [OTHER]: { parent: '', title: 'Other' },
};
// ListType=All does not return archived documents (spike S1), so they are kept apart.
const documents = { [FORMS]: { live: ['Expense form.docx'], archived: [] }, [POLICIES]: { live: [], archived: ['Old policy.pdf'] } };

// mode: how ArchiveProcess behaves. version/state: the model's revision (1 in progress,
// 2 awaiting approval, 3 published), for the move plan's draft check and for how an
// ownership change is written.
const owner = { id: 7, name: 'Old Owner' };
const expert = { id: 8, name: 'Old Expert' };
const procs = {
  [id(1)]: { name: 'Outright', group: FIN, archived: false, mode: 'outright', rev: 100, version: '2.0', state: 3, owner, expert },
  [id(2)]: { name: 'Needs approval', group: FIN, archived: false, mode: 'pending', rev: 200, version: '1.1', state: 1, owner, expert },
  [id(3)]: { name: 'Disabled owner', group: SUB, archived: false, mode: 'refuse', rev: 300, version: '0.3', state: 1, owner, expert },
  [id(4)]: { name: 'Fails but works', group: SUB, archived: false, mode: 'fail-but-works', rev: 400, version: '0.2', state: 1, owner, expert },
  [id(5)]: { name: 'Elsewhere', group: OTHER, archived: false, mode: 'outright', rev: 500, version: '1.0', state: 3, owner, expert },
  [id(6)]: { name: 'Old thing', group: RET, archived: false, mode: 'outright', rev: 600, version: '1.0', state: 3, owner, expert },
};
const scimUsers = [
  { id: '101', userName: 'ann@example.com', displayName: 'Ann Owner', active: true },
  { id: '102', userName: 'bob@example.com', name: { givenName: 'Bob', familyName: 'Expert' }, active: true },
];

const item = (uniqueId, title, itemType, n) => ({
  id: n, uniqueId, title, itemType, itemOrder: 0, hasChild: itemType === 'group',
  totalSubgroups: null, totalStakeholderUsers: null, totalPermissionRoles: null, totalPermissionUsers: null, variationSetId: null,
});
const levels = (parent) => [
  ...Object.entries(groups).filter(([, g]) => g.parent === parent).map(([u, g], i) => item(u, g.title, 'group', 900 + i)),
  ...Object.entries(procs).filter(([, p]) => p.group === parent && !p.archived).map(([u, p], i) => item(u, p.name, 'process', i + 1)),
];
const chain = (g) => {
  const out = [];
  for (let at = g; at && groups[at]; at = groups[at].parent) out.unshift({ id: at, name: groups[at].title });
  return groups[g] ? [{ id: ROOT, name: 'Example Organisation' }, ...out] : [];
};

const log = [];
let expired = null;
const REDIRECTING = [/^\/Api\/v1\/Processes\/[^/]+$/, /^\/Process\/Edit\/ArchiveProcess$/];
const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const p = url.pathname.replace(/^\/tenant/, '');
  log.push(`${req.method} ${p}${url.search} ${body}`);

  if (p === '/_log') return send(res, 200, log);
  if (p === '/_expire') {
    expired = url.searchParams.get('mode') ?? 'all';
    return send(res, 200, { expired });
  }
  if (p === '/oauth2/token') return send(res, 200, { access_token: 'tok', expires_in: 3600 });
  if (p === '/api/scim/users') {
    if (req.headers.authorization !== 'Bearer scim-key') return send(res, 401, { detail: 'bad key' });
    return send(res, 200, { Resources: scimUsers, totalResults: scimUsers.length });
  }
  if (expired && REDIRECTING.some((r) => r.test(p))) {
    res.writeHead(302, { location: '/tenant/Account/Login' });
    return res.end();
  }
  if (expired === 'all' && p !== '/api/scim/users') return send(res, 401, { message: 'no' });
  if (req.headers.authorization !== 'Bearer tok') return send(res, 401, { message: 'no' });

  if (p === '/Process/View/GetChildProcessGroupTreeItems') {
    return send(res, 200, { treeItems: levels(url.searchParams.get('uniqueId') ?? ''), parentUniqueId: null });
  }
  if (p === '/Bff/Process/api/v1/processes') {
    const archived = url.searchParams.get('ListType') === '7';
    const items = Object.entries(procs)
      .filter(([, x]) => x.archived === archived)
      .map(([u, x]) => ({
        processId: 1, processName: x.name, processUniqueId: u, processState: '', groupId: Number(x.group.slice(-3)),
        groupUniqueId: x.group, groupName: 'G', processOwner: '', processExpert: '', groupExists: !x.groupGone,
      }));
    return send(res, 200, { items, totalItemCount: items.length });
  }
  if (p === '/Process/Edit/ArchiveProcess') {
    const { processUniqueId } = JSON.parse(body);
    const x = procs[processUniqueId];
    if (x.mode === 'refuse') return send(res, 400, { message: 'The process owner is a disabled user' });
    if (x.mode === 'pending') { x.rev++; x.pendingArchive = true; return send(res, 200, {}); }
    x.archived = true;
    x.rev++;
    if (x.mode === 'fail-but-works') return send(res, 500, { message: 'Timeout' });
    return send(res, 200, {});
  }
  if (p === '/Process/Edit/ValidateProcessAction') {
    const x = procs[url.searchParams.get('processUniqueId')];
    if (x.state === 3) {
      return send(res, 200, { isValid: true, isCancelled: false, isPrompt: true, title: 'Publish New Version?', message: 'for this change to take effect a new version will be created and published' });
    }
    if (x.version.startsWith('0.')) return send(res, 200, { isValid: true, isCancelled: false, isPrompt: false, title: null, message: null });
    return send(res, 200, { isValid: true, isCancelled: false, isPrompt: true, title: 'Publish New Version?', message: `'${x.name}' which has outstanding changes, for this change to take effect all other outstanding changes will also be published` });
  }
  if (p === '/Process/View/GetTotalSpecifiedGroupRoleAndUserViewers') {
    return send(res, 200, { success: true, data: url.searchParams.getAll('groupIds').map((g) => ({ groupId: Number(g), totalUsers: Number(g) % 50, totalRoles: 2 })) });
  }
  if (p === '/Process/Edit/ReorderTreeNodes') {
    const [n] = JSON.parse(body);
    if (groups[n.ChildUniqueId]) groups[n.ChildUniqueId].parent = n.ParentUniqueId;
    else procs[n.ChildUniqueId].group = n.ParentUniqueId;
    return send(res, 200, { success: true, errors: [] });
  }
  if (p === '/bff/document/api/v1/documents') {
    const held = documents[url.searchParams.get('ProcessGroupId')] ?? { live: [], archived: [] };
    const names = url.searchParams.get('ListType') === 'Archived' ? held.archived : held.live;
    return send(res, 200, { items: names.map((documentName) => ({ documentName })), totalItemCount: names.length });
  }
  if (p === '/bff/navigation/api/v1/breadcrumb') {
    const items = chain(url.searchParams.get('id')).map((g, i) => ({
      id: g.id, parentId: null, name: g.name, position: i + 1, type: 'ProcessGroup', url: `http://localhost:${port}/tenant/Process/Group/${g.id}`, version: null,
    }));
    return send(res, 200, { isChildren: false, breadcrumbItems: items });
  }
  if (p === '/Process/Edit/DeleteGroup') {
    const { processGroupUniqueId: g } = JSON.parse(body);
    const held = documents[g];
    if (held && held.live.length + held.archived.length > 0) {
      return send(res, 409, { errorCode: 'AssociatedContents', caption: 'Unable to Delete Group', additionalInfos: { documents: [...held.live, ...held.archived] } });
    }
    if (levels(g).length > 0) return send(res, 409, { errorCode: 'AssociatedContents', caption: 'Unable to Delete Group', additionalInfos: {} });
    delete groups[g];
    for (const x of Object.values(procs)) if (x.group === g) x.groupGone = true;
    return send(res, 200, { isValid: true });
  }

  let m = p.match(/^\/Api\/v1\/Processes\/([^/]+)\/Publish$/);
  if (m) {
    const x = procs[m[1]];
    const b = JSON.parse(body);
    if (typeof b.ProcessRevisionEditId !== 'string' || Number(b.ProcessRevisionEditId) !== x.rev) {
      return send(res, 400, { message: 'stale revision ' + b.ProcessRevisionEditId });
    }
    if (x.pendingArchive) x.archived = true;
    else {
      x.state = 3;
      x.version = `${Number(x.version.split('.')[0]) + 1}.0`;
    }
    x.pendingArchive = false;
    return send(res, 200, { actionUrl: '/x' });
  }
  m = p.match(/^\/bff\/Process\/api\/v1\/processes\/([^/]+)\/revisions\/latest$/);
  if (m) return send(res, 200, { latestProcessRevisionEditId: procs[m[1]].rev });
  m = p.match(/^\/Api\/v1\/Processes\/([^/]+)$/);
  if (m && req.method === 'PUT') {
    const x = procs[m[1]];
    const b = JSON.parse(body);
    if (typeof b.ProcessJson !== 'string') return send(res, 500, { message: 'ProcessJson must be a string' });
    if (b.SuppressChangeNotification !== true) return send(res, 400, { message: 'mock: notifications must be suppressed' });
    const model = JSON.parse(b.ProcessJson);
    if (model.ProcessRevisionEditId !== x.rev) return send(res, 409, { message: 'stale' });
    x.owner = { id: model.OwnerId, name: model.Owner };
    x.expert = { id: model.ExpertId, name: model.Expert };
    const [major, minor] = x.version.split('.').map(Number);
    x.version = `${major}.${minor + 1}`;
    x.state = b.DoSubmitForApproval ? 2 : 1;
    x.rev++;
    res.writeHead(204);
    return res.end();
  }
  if (m) {
    const x = procs[m[1]];
    if (!x) return send(res, 404, { message: 'not found' });
    return send(res, 200, {
      processJson: {
        UniqueId: m[1], Name: x.name, Version: x.version, isArchived: x.archived, ProcessRevisionEditId: x.rev, ProcessRevisionStateId: x.state,
        OwnerId: x.owner.id, Owner: x.owner.name, ExpertId: x.expert.id, Expert: x.expert.name, Objective: 'kept as is',
        ProcessGroupItems: { ProcessGroup: { UniqueId: x.group, Name: groups[x.group]?.title ?? '' } },
      },
      processActions: { CanSave: true, CanPublishAfterEdit: true, CanSubmitForApprovalAfterEdit: true },
    });
  }
  send(res, 404, { message: 'unknown ' + p });
}).listen(port, () => console.log(`mock Process Manager on ${port}`));
