import { Button, Select, SegmentedControl, TextInput } from '@donel-dev/design-system';
import type { SegmentedControlOption, SelectOption } from '@donel-dev/design-system';
import { useEffect, useState } from 'react';
import type { ProjectInfo } from '../../shared';
import type { EffortLevel, ModelAlias, PermissionMode } from '../../shared/commandBuilder';
import styles from './Launcher.module.css';

// T008 — Launcher real (ui-spec §4, FR-003, CA-1). Este componente só
// coleta o estado dos controles e devolve as opções resolvidas via
// `onLaunch` — quem chama `buildClaudeArgs` e abre a aba é o App.tsx, para
// o CommandBuilder (T006) continuar puro/sem I/O e 100% coberto por vitest
// sem precisar simular DOM aqui (ui-spec/tasks.md: PTY/UI validam por smoke).

const MODEL_OPTIONS: SegmentedControlOption[] = [
  { value: 'fable', label: 'fable' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
];

// Rótulo "med" só por densidade visual (fidelidade ao Brief 3 do design
// reference) — o value continua "medium", o alias que o CommandBuilder/CLI
// realmente espera (FR-003, EffortLevel).
const EFFORT_OPTIONS: SegmentedControlOption[] = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'med' },
  { value: 'high', label: 'high' },
  { value: 'xhigh', label: 'xhigh' },
  { value: 'max', label: 'max' },
];

// Mesmos rótulo/descrição do Brief 3 (design reference), que já batem com
// a tabela FR-003/PermissionMode.
const PERMISSION_OPTIONS: SelectOption[] = [
  { value: 'manual', label: 'manual', description: 'pede confirmação a cada ação' },
  { value: 'acceptEdits', label: 'acceptEdits', description: 'aceita edições de arquivo automaticamente' },
  { value: 'auto', label: 'auto', description: 'roda ferramentas sem confirmar' },
  { value: 'plan', label: 'plan', description: 'só planeja, não executa' },
  { value: 'dontAsk', label: 'dontAsk', description: 'não pergunta, mas respeita bloqueios' },
  { value: 'bypassPermissions', label: 'bypassPermissions', description: 'ignora todas as barreiras (cuidado)' },
];

// Defaults do Brief 3 (design reference): fable/high/acceptEdits — mesmo
// ponto de partida do ConfigStore (T015, config-store.ts
// `DEFAULT_LAUNCHER_DEFAULTS`) até o primeiro "▶ Iniciar" real persistir uma
// escolha diferente (fallback só pra quando `launcherDefaults` ainda não
// chegou do main process, ex. primeiro paint antes do `config:get` resolver).
const DEFAULT_MODEL: ModelAlias = 'fable';
const DEFAULT_EFFORT: EffortLevel = 'high';
const DEFAULT_PERMISSION: PermissionMode = 'acceptEdits';

export interface LauncherLaunchOptions {
  model: ModelAlias;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /** Já trim()ado; string vazia = flag `-n` omitida (FR-003, "nome vazio = ok"). */
  sessionName: string;
  projectPath: string;
  projectName: string;
}

export interface LauncherProps {
  /** Lista de projetos conhecidos (sidebar) — alimenta o seletor "Projeto-alvo". */
  projects: ProjectInfo[];
  /** Herdado da seleção da sidebar (ui-spec §4); o campo abaixo continua editável depois. */
  defaultProjectPath?: string;
  /** T015 (FR-007 "defaults do launcher") — última escolha persistida no ConfigStore; `undefined` até `config:get` resolver (cai nos `DEFAULT_*` locais). */
  launcherDefaults?: { model: ModelAlias; effort: EffortLevel; permissionMode: PermissionMode };
  onLaunch: (options: LauncherLaunchOptions) => void;
}

export function Launcher({ projects, defaultProjectPath, launcherDefaults, onLaunch }: LauncherProps): React.JSX.Element {
  const [model, setModel] = useState<ModelAlias>(launcherDefaults?.model ?? DEFAULT_MODEL);
  const [effort, setEffort] = useState<EffortLevel>(launcherDefaults?.effort ?? DEFAULT_EFFORT);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(launcherDefaults?.permissionMode ?? DEFAULT_PERMISSION);
  const [sessionName, setSessionName] = useState('');
  const [projectPath, setProjectPath] = useState(defaultProjectPath ?? '');

  // "Herdado da seleção da sidebar": cada nova seleção reflete aqui — mas
  // só até o próximo clique na sidebar; edições manuais no meio-tempo não
  // são sobrescritas (o efeito só dispara quando o valor herdado muda).
  useEffect(() => {
    setProjectPath(defaultProjectPath ?? '');
  }, [defaultProjectPath]);

  const projectOptions: SelectOption[] = projects.map((project) => ({
    value: project.path,
    label: project.name,
  }));
  const selectedProject = projects.find((project) => project.path === projectPath);
  const canLaunch = projectPath.trim().length > 0;

  const handleLaunch = (): void => {
    if (!canLaunch) return;
    onLaunch({
      model,
      effort,
      permissionMode,
      sessionName: sessionName.trim(),
      projectPath,
      projectName: selectedProject?.name ?? projectPath,
    });
  };

  return (
    <div className={styles.launcher} data-testid="launcher">
      <h2 className={styles.sectionTitle}>Lançar sessão</h2>

      <div className={styles.field}>
        <span className={styles.label}>Modelo</span>
        <SegmentedControl
          options={MODEL_OPTIONS}
          value={model}
          onChange={(value) => setModel(value as ModelAlias)}
          ariaLabel="Modelo"
        />
      </div>

      <div className={styles.field}>
        <span className={styles.label}>Esforço</span>
        <SegmentedControl
          options={EFFORT_OPTIONS}
          value={effort}
          onChange={(value) => setEffort(value as EffortLevel)}
          ariaLabel="Esforço"
        />
      </div>

      <Select
        label="Permissões"
        value={permissionMode}
        options={PERMISSION_OPTIONS}
        onChange={(value) => setPermissionMode(value as PermissionMode)}
      />

      <TextInput
        label="Nome"
        placeholder="opcional"
        value={sessionName}
        onChange={(event) => setSessionName(event.target.value)}
      />

      <div className={styles.field}>
        <span className={styles.label}>Projeto-alvo</span>
        <Select
          value={projectPath}
          options={projectOptions}
          onChange={setProjectPath}
          placeholder="Selecione um projeto"
        />
      </div>

      <Button variant="primary" fullWidth onClick={handleLaunch} disabled={!canLaunch}>
        ▶ Iniciar
      </Button>
    </div>
  );
}
