import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const list = vi.fn();
const get = vi.fn();
const getEnvironment = vi.fn();
const assignEnvironment = vi.fn();

vi.mock('@/services/environments', () => ({
  environmentsService: {
    list: (...args: unknown[]) => list(...args),
    get: (...args: unknown[]) => get(...args),
  },
}));

vi.mock('@/services/projects', () => ({
  projectsService: {
    getEnvironment: (...args: unknown[]) => getEnvironment(...args),
    assignEnvironment: (...args: unknown[]) => assignEnvironment(...args),
  },
}));

const listBlocks = vi.fn();
vi.mock('@/services/blocks', () => ({
  blocksService: { list: (...args: unknown[]) => listBlocks(...args) },
}));

// Radix Select becomes a native <select>. The label is read off the SelectTrigger
// child (where the real component carries it) so the default picker, each override
// row and the add-a-stage picker are individually addressable.
vi.mock('@/components/ui/select', () => {
  const findLabel = (node: unknown): string | undefined => {
    if (!node) return undefined;
    if (Array.isArray(node)) {
      for (const child of node) {
        const label = findLabel(child);
        if (label) return label;
      }
      return undefined;
    }
    if (typeof node === 'object') {
      const props = (node as { props?: Record<string, unknown> }).props;
      if (!props) return undefined;
      if (typeof props['aria-label'] === 'string') return props['aria-label'];
      return findLabel(props.children);
    }
    return undefined;
  };
  return {
    Select: ({
      value,
      onValueChange,
      disabled,
      children,
    }: {
      value?: string;
      onValueChange: (value: string) => void;
      disabled?: boolean;
      children: React.ReactNode;
    }) => (
      <select
        aria-label={findLabel(children) ?? 'Environment'}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
      >
        <option value="" />
        {children}
      </select>
    ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
      <option value={value}>{children}</option>
    ),
  };
});

import { EnvironmentTab } from './EnvironmentTab';

const environments = [
  {
    environmentId: 'standard',
    name: 'Standard Node/Python',
    description: '',
    system: true,
    status: 'PUBLISHED',
    baseEnvironmentId: null,
    currentRevisionId: 'core-1',
    publishedRevisionId: 'core-1',
    updateAvailable: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  },
  {
    environmentId: 'rust-ci',
    name: 'Rust CI',
    description: '',
    system: false,
    status: 'PUBLISHED',
    baseEnvironmentId: 'standard',
    currentRevisionId: 'r-7',
    publishedRevisionId: 'r-7',
    updateAvailable: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  },
  {
    environmentId: 'gpu-fleet',
    name: 'GPU Fleet',
    description: '',
    system: false,
    status: 'PUBLISHED',
    kind: 'EC2' as const,
    baseEnvironmentId: null,
    currentRevisionId: 'r-ec2',
    publishedRevisionId: 'r-ec2',
    updateAvailable: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  },
];

const gpuLaunchSpec = {
  schemaVersion: 1,
  platform: 'linux' as const,
  architecture: 'x86_64' as const,
  imageRef: 'ami-0123456789abcdef0',
  imageId: 'ami-0123456789abcdef0',
  imageOwnerAccountId: null,
  instanceTypes: ['g5.2xlarge'],
  instanceFamilies: [],
  instanceRequirements: null,
  purchaseOption: 'on-demand' as const,
  spotFallbackToOnDemand: true,
  allocationStrategy: 'price-capacity-optimized' as const,
  maxPricePerHour: null,
  availabilityZones: [],
  rootVolume: { sizeGiB: 200, type: 'gp3' as const },
  workspaceOnInstanceStore: false,
  associatePublicIp: false,
  securityGroupIds: [],
  additionalPolicyArns: [],
  workspacePath: '/mnt/workspace',
  parkPolicy: 'release' as const,
  strategyId: 'per-stage-ephemeral' as const,
  maxInstances: 4,
  maxConcurrentPlacements: 4,
  maxLifetimeSeconds: 28800,
  stageTimeoutSeconds: 28800,
  bootstrapTimeoutSeconds: 900,
  maxHourlyCostUsd: null,
  tags: {},
};

const stageBlocks = {
  blocks: [
    { blockId: 'build-and-test', name: 'Build and Test' },
    // The advisory hint the methodology declares; binding is still a deployment
    // decision, so a mismatch must warn and never block.
    { blockId: 'train-model', name: 'Train Model', requiresCompute: { accelerator: 'gpu' } },
  ],
};

const detail = (environmentId: string) => {
  const environment = environments.find((item) => item.environmentId === environmentId)!;
  const revisionId = environment.publishedRevisionId!;
  if (environmentId === 'gpu-fleet') {
    const revision = {
      environmentId,
      revisionId,
      status: 'PUBLISHED',
      kind: 'EC2' as const,
      launchSpec: gpuLaunchSpec,
      launchTemplateId: 'lt-0abc',
      launchTemplateVersion: '1',
      runtimeCompatibilityVersion: '1',
      createdAt: '2026-08-10T00:00:00.000Z',
      updatedAt: '2026-08-10T00:00:00.000Z',
    };
    return { environment, revisions: [revision], publishedRevision: revision };
  }
  const rust = {
    toolId: 'rust',
    name: 'Rust Toolchain',
    category: 'language-sdk',
    publisher: 'The Rust project',
    versionId: 'tv-rust-1',
    version: '1.89.0',
    imageUri: 'tools',
    imageDigest: `sha256:${'b'.repeat(64)}`,
    imageSizeBytes: 100,
    trustLevel: 'PUBLISHER_VERIFIED',
    source: null,
    executables: [{ name: 'rustc', path: 'bin/rustc' }],
    dependencies: [],
    aptPackages: [{ name: 'build-essential', version: '12.9' }],
    environmentVariables: {},
    verification: {
      preset: 'rust',
      versionCommand: { argv: ['rustc', '--version'], expected: '1.89.0' },
      script: '',
      files: [],
    },
    scanFindings: null,
    securityFindingsAcceptedAt: null,
    securityFindingsAcceptedBy: null,
  };
  const standardRecipe = {
    schemaVersion: 1 as const,
    base: null,
    tools: {
      node: { version: '24.15.0', source: 'base' as const },
      python: { version: '3.11', source: 'base' as const },
    },
    buildTools: {},
    aptPackages: [],
    environmentVariables: {},
    buildCommands: [],
  };
  const rustRecipe = {
    schemaVersion: 2 as const,
    base: {
      environmentId: 'standard',
      revisionId: 'core-1',
      imageUri: 'repo',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      imageSizeBytes: 100,
    },
    toolVersionIds: ['tv-rust-1'],
    tools: [rust],
    resolvedTools: [rust],
    aptPackages: [{ name: 'build-essential', version: '12.9' }],
    environmentVariables: {},
    buildCommands: [],
  };
  const recipe = environmentId === 'rust-ci' ? rustRecipe : standardRecipe;
  const revision = {
    environmentId,
    revisionId,
    status: 'PUBLISHED',
    runtimeCompatibilityVersion: '1',
    imageUri: 'repo',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    runtimeArn: 'runtime',
    runtimeEndpoint: `revision_${revisionId}`,
    recipe,
    flattenedRecipe: recipe,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  };
  return { environment, revisions: [revision], publishedRevision: revision };
};

const project = {
  id: 'p1',
  name: 'Space',
  gitProvider: 'github' as const,
  gitRepo: 'owner/repo',
  agentCli: 'kiro' as const,
  createdAt: '2026-08-10T00:00:00.000Z',
  trackers: [],
  environmentId: 'standard',
  repos: [
    {
      url: 'owner/repo',
      provider: 'github' as const,
      role: 'primary' as const,
      detectedStack: 'Python and Rust',
      addedAt: '2026-08-10T00:00:00.000Z',
    },
  ],
};

describe('EnvironmentTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(environments);
    get.mockImplementation((environmentId: string) => Promise.resolve(detail(environmentId)));
    listBlocks.mockResolvedValue(stageBlocks);
    getEnvironment.mockResolvedValue({
      environmentId: 'standard',
      stageEnvironments: {},
      environment: environments[0],
      revision: detail('standard').publishedRevision,
    });
    assignEnvironment.mockResolvedValue({
      environmentId: 'rust-ci',
      stageEnvironments: {},
      environment: environments[1],
      revision: detail('rust-ci').publishedRevision,
    });
  });

  it('shows repository compatibility warnings for missing tools', async () => {
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={vi.fn()} />);
    expect(
      await screen.findByText('Rust is detected in a repository but is not included.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Python is detected/)).not.toBeInTheDocument();
  });

  it('assigns a published environment to the space', async () => {
    const user = userEvent.setup();
    const onProjectUpdated = vi.fn();
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={onProjectUpdated} />);
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Environment' }),
      'rust-ci',
    );
    await user.click(screen.getByRole('button', { name: 'Assign Environment' }));
    expect(assignEnvironment).toHaveBeenCalledWith('p1', 'rust-ci', {});
    expect(onProjectUpdated).toHaveBeenCalledWith({ environmentId: 'rust-ci' });
  });
});

describe('EnvironmentTab — per-stage overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(environments);
    get.mockImplementation((environmentId: string) => Promise.resolve(detail(environmentId)));
    listBlocks.mockResolvedValue(stageBlocks);
    getEnvironment.mockResolvedValue({
      environmentId: 'standard',
      stageEnvironments: {},
      environment: environments[0],
      revision: detail('standard').publishedRevision,
    });
    assignEnvironment.mockImplementation(
      (_id: string, environmentId: string, stageEnvironments: Record<string, string>) =>
        Promise.resolve({
          environmentId,
          stageEnvironments,
          environment: environments.find((item) => item.environmentId === environmentId) ?? null,
          revision: null,
        }),
    );
  });

  it('never offers an EC2 environment as the space default', async () => {
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={vi.fn()} />);
    const picker = await screen.findByRole('combobox', { name: 'Environment' });
    const options = [...picker.querySelectorAll('option')].map((option) => option.value);
    expect(options).toContain('standard');
    expect(options).toContain('rust-ci');
    expect(options).not.toContain('gpu-fleet');
    expect(screen.getByText(/The default must be an AgentCore environment/)).toBeInTheDocument();
  });

  it('offers EC2 environments for a per-stage override and saves the map', async () => {
    const user = userEvent.setup();
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={vi.fn()} />);
    expect(await screen.findByText('Every stage runs on the default environment.')).toBeVisible();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Stage' }), 'train-model');
    const row = await screen.findByRole('combobox', { name: 'Environment for Train Model' });
    expect([...row.querySelectorAll('option')].map((option) => option.value)).toContain(
      'gpu-fleet',
    );
    await user.selectOptions(row, 'gpu-fleet');

    await user.click(screen.getByRole('button', { name: 'Assign Environment' }));
    await waitFor(() =>
      expect(assignEnvironment).toHaveBeenCalledWith('p1', 'standard', {
        'train-model': 'gpu-fleet',
      }),
    );
  });

  it('clears an existing override and saves the map without it', async () => {
    const user = userEvent.setup();
    getEnvironment.mockResolvedValue({
      environmentId: 'standard',
      stageEnvironments: { 'build-and-test': 'rust-ci' },
      environment: environments[0],
      revision: detail('standard').publishedRevision,
    });
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={vi.fn()} />);
    expect(
      await screen.findByRole('combobox', { name: 'Environment for Build and Test' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove override for Build and Test' }));
    expect(screen.getByText('Every stage runs on the default environment.')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Assign Environment' }));
    await waitFor(() => expect(assignEnvironment).toHaveBeenCalledWith('p1', 'standard', {}));
  });

  it('warns, advisorily, when the bound environment misses a stage requiresCompute hint', async () => {
    const user = userEvent.setup();
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={vi.fn()} />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Stage' }), 'train-model');
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Environment for Train Model' }),
      'rust-ci',
    );
    expect(await screen.findByText(/stage needs a GPU/)).toBeInTheDocument();
    expect(screen.getByText(/advisory — the binding is still used/)).toBeInTheDocument();
    // Advisory only: nothing is disabled and the map still saves.
    const save = screen.getByRole('button', { name: 'Assign Environment' });
    expect(save).toBeEnabled();
    await user.click(save);
    await waitFor(() =>
      expect(assignEnvironment).toHaveBeenCalledWith('p1', 'standard', {
        'train-model': 'rust-ci',
      }),
    );
  });

  it('drops the advisory once the bound EC2 launch spec turns out to satisfy the hint', async () => {
    getEnvironment.mockResolvedValue({
      environmentId: 'standard',
      stageEnvironments: { 'train-model': 'gpu-fleet' },
      environment: environments[0],
      revision: detail('standard').publishedRevision,
    });
    render(<EnvironmentTab project={project} canEdit onProjectUpdated={vi.fn()} />);
    // The spec is fetched for the bound EC2 environment; g5 is an accelerated
    // family, so the warning must clear.
    await waitFor(() => expect(get).toHaveBeenCalledWith('gpu-fleet'));
    await waitFor(() => expect(screen.queryByText(/stage needs a GPU/)).not.toBeInTheDocument());
  });
});
