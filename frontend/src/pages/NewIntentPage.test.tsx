import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';

// Radix Select relies on pointer-capture / scrollIntoView APIs jsdom doesn't
// implement — polyfill just enough for the trigger/option interaction below.
beforeEach(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

// Placement defaults: nothing overridden by the space, which is the common case.
// The per-run map is inherited from here, so every test needs it resolved.
beforeEach(() => {
  getProjectEnvironment.mockReset().mockResolvedValue({
    environmentId: 'standard',
    stageEnvironments: {},
    environment: { environmentId: 'standard', name: 'Standard Node/Python' },
    revision: null,
  });
  listEnvironments.mockReset().mockResolvedValue(ENVIRONMENTS);
  getEnvironmentDetail.mockReset().mockResolvedValue({
    environment: ENVIRONMENTS[1],
    revisions: [],
    publishedRevision: null,
  });
  listBlocks.mockReset().mockResolvedValue(STAGE_BLOCKS);
});

const useProjectCache = vi.fn();
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (...a: unknown[]) => useProjectCache(...a),
}));

const create = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    create: (...a: unknown[]) => create(...a),
  },
}));

const listBranches = vi.fn();
vi.mock('@/services/sourceControl', () => ({
  sourceControlService: {
    listBranches: (...a: unknown[]) => listBranches(...a),
  },
}));

const getProjectEnvironment = vi.fn();
vi.mock('@/services/projects', () => ({
  projectsService: {
    getEnvironment: (...a: unknown[]) => getProjectEnvironment(...a),
  },
}));

const listEnvironments = vi.fn();
const getEnvironmentDetail = vi.fn();
vi.mock('@/services/environments', () => ({
  environmentsService: {
    list: (...a: unknown[]) => listEnvironments(...a),
    get: (...a: unknown[]) => getEnvironmentDetail(...a),
  },
}));

const listBlocks = vi.fn();
vi.mock('@/services/blocks', () => ({
  blocksService: { list: (...a: unknown[]) => listBlocks(...a) },
}));

import NewIntentPage from './NewIntentPage';

const ENVIRONMENTS = [
  {
    environmentId: 'standard',
    name: 'Standard Node/Python',
    description: '',
    system: true,
    status: 'PUBLISHED',
    kind: 'AGENTCORE',
    baseEnvironmentId: null,
    currentRevisionId: 'core-1',
    publishedRevisionId: 'core-1',
    updateAvailable: false,
    createdAt: 'T',
    updatedAt: 'T',
  },
  {
    environmentId: 'gpu-fleet',
    name: 'GPU Fleet',
    description: '',
    system: false,
    status: 'PUBLISHED',
    kind: 'EC2',
    baseEnvironmentId: null,
    currentRevisionId: 'r-ec2',
    publishedRevisionId: 'r-ec2',
    updateAvailable: false,
    createdAt: 'T',
    updatedAt: 'T',
  },
];

const STAGE_BLOCKS = {
  blocks: [
    { blockId: 'build-and-test', name: 'Build and Test' },
    { blockId: 'train-model', name: 'Train Model' },
  ],
};

const baseProject = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'P',
  gitProvider: 'github',
  gitRepo: 'owner/repo',
  agentCli: 'kiro',
  createdAt: 'T',
  trackers: [],
  repos: [],
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/new']}>
      <Routes>
        <Route path="/space/:projectId/intent/new" element={<NewIntentPage />} />
        <Route
          path="/space/:projectId/intent/:intentId/compose"
          element={<div data-testid="compose-page" />}
        />
      </Routes>
    </MemoryRouter>,
  );

describe('NewIntentPage — DRAFT-first creation', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    listBranches
      .mockReset()
      .mockResolvedValue({ branches: ['main', 'develop'], defaultBranch: 'main' });
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: baseProject({ repos: [] }), loading: false });
  });

  it('creates the DRAFT without a scope and lands on the compose page', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Prompt'), 'Build X');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // Scope selection moved to the collaborative compose page — the server
    // defaults it at create.
    const payload = create.mock.calls[0][1];
    expect(payload.scope).toBeUndefined();
    expect(await screen.findByTestId('compose-page')).toBeInTheDocument();
  });

  it('a title alone is enough to start a draft (prompt is refined collaboratively)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Title'), 'Add auth');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
});

describe('NewIntentPage — base branch selection', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    listBranches
      .mockReset()
      .mockResolvedValue({ branches: ['main', 'develop'], defaultBranch: 'main' });
    useProjectCache.mockReset();
  });

  it('hides the base-branch section for a project with no repos', async () => {
    useProjectCache.mockReturnValue({ project: baseProject({ repos: [] }), loading: false });
    renderPage();
    await screen.findByLabelText('Prompt');
    expect(screen.queryByText('Base branch')).not.toBeInTheDocument();
  });

  it('shows a collapsed base-branch section for a project with repos, and never fetches branches unless expanded', async () => {
    useProjectCache.mockReturnValue({
      project: baseProject({ repos: [{ url: 'owner/repo', role: 'primary' }] }),
      loading: false,
    });
    renderPage();
    expect(await screen.findByText('Base branch')).toBeInTheDocument();
    expect(listBranches).not.toHaveBeenCalled();
  });

  it('fetches each repo branch list once the section is expanded', async () => {
    const user = userEvent.setup();
    useProjectCache.mockReturnValue({
      project: baseProject({
        repos: [
          { url: 'owner/repo', role: 'primary' },
          { url: 'owner/web', role: 'secondary' },
        ],
      }),
      loading: false,
    });
    renderPage();
    await user.click(await screen.findByText('Base branch'));
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));
    expect(listBranches).toHaveBeenCalledWith('p1', 'github', 'owner/repo');
    expect(listBranches).toHaveBeenCalledWith('p1', 'github', 'owner/web');
    expect(await screen.findByLabelText('owner/repo')).toBeInTheDocument();
    expect(await screen.findByLabelText('owner/web')).toBeInTheDocument();
  });

  it('creates the intent WITHOUT baseBranches when the picker is never touched', async () => {
    const user = userEvent.setup();
    useProjectCache.mockReturnValue({
      project: baseProject({ repos: [{ url: 'owner/repo', role: 'primary' }] }),
      loading: false,
    });
    renderPage();
    await user.type(await screen.findByLabelText('Prompt'), 'Build X');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][1];
    expect(payload.baseBranches).toBeUndefined();
  });

  it('includes only the explicitly-picked repo in baseBranches on submit', async () => {
    const user = userEvent.setup();
    useProjectCache.mockReturnValue({
      project: baseProject({
        repos: [
          { url: 'owner/repo', role: 'primary' },
          { url: 'owner/web', role: 'secondary' },
        ],
      }),
      loading: false,
    });
    renderPage();
    await user.type(await screen.findByLabelText('Prompt'), 'Build X');
    await user.click(await screen.findByText('Base branch'));
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));

    const repoSelect = await screen.findByLabelText('owner/repo');
    await user.click(repoSelect);
    const option = await screen.findByRole('option', { name: /^develop$/ });
    await user.click(option);

    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][1];
    expect(payload.baseBranches).toEqual({ 'owner/repo': 'develop' });
  });
});

describe('NewIntentPage — per-run stage placement', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    listBranches
      .mockReset()
      .mockResolvedValue({ branches: ['main', 'develop'], defaultBranch: 'main' });
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: baseProject({ repos: [] }), loading: false });
  });

  it('says every stage runs on the space default when nothing is inherited', async () => {
    renderPage();
    expect(await screen.findByText('(every stage on Standard Node/Python)')).toBeInTheDocument();
    // The environment list and stage catalogue are only needed to EDIT the map.
    expect(listEnvironments).not.toHaveBeenCalled();
    expect(listBlocks).not.toHaveBeenCalled();
  });

  it('marks inherited rows as inherited and does not send them again', async () => {
    const user = userEvent.setup();
    getProjectEnvironment.mockResolvedValue({
      environmentId: 'standard',
      stageEnvironments: { 'train-model': 'gpu-fleet' },
      environment: { environmentId: 'standard', name: 'Standard Node/Python' },
      revision: null,
    });
    renderPage();
    expect(await screen.findByText('(1 stage bound elsewhere)')).toBeInTheDocument();
    await user.click(screen.getByText('Where stages run'));
    expect(await screen.findByText('Inherited')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Prompt'), 'Build X');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // An untouched run inherits: only the DELTA travels, and there is none.
    expect(create.mock.calls[0][1].stageEnvironments).toBeUndefined();
  });

  it('sends an override for this run only', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByText('Where stages run'));
    await waitFor(() => expect(listBlocks).toHaveBeenCalled());

    await user.click(await screen.findByRole('combobox', { name: 'Stage' }));
    await user.click(await screen.findByRole('option', { name: /Train Model/ }));

    await user.click(await screen.findByRole('combobox', { name: 'Environment for Train Model' }));
    await user.click(await screen.findByRole('option', { name: /GPU Fleet/ }));
    expect(await screen.findByText('Overridden for this run')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Prompt'), 'Build X');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1].stageEnvironments).toEqual({ 'train-model': 'gpu-fleet' });
  });

  it('sends null to drop an inherited row for this run', async () => {
    const user = userEvent.setup();
    getProjectEnvironment.mockResolvedValue({
      environmentId: 'standard',
      stageEnvironments: { 'train-model': 'gpu-fleet' },
      environment: { environmentId: 'standard', name: 'Standard Node/Python' },
      revision: null,
    });
    renderPage();
    await user.click(await screen.findByText('Where stages run'));
    await user.click(
      await screen.findByRole('button', { name: 'Remove override for Train Model' }),
    );
    // The row stays, so the clearing is visible and reversible.
    expect(await screen.findByText('Cleared for this run')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Restore Train Model' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Prompt'), 'Build X');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][1].stageEnvironments).toEqual({ 'train-model': null });
  });
});
