// T014 — tipos IPC do domínio de perfis (FR-005, FR-012, plan.md
// "profiles:list|create|activate|doctor"). `ProfileManager`
// (src/main/profile-manager.ts) e `quota-headroom.ts` são quem de fato lêem
// disco/spawnam `quota-axi`; este arquivo só espelha o contrato pro
// preload/renderer (mesmo padrão de src/shared/sessions.ts pro
// SessionIndexer). Canais além dos 4 originalmente listados em plan.md
// (`headroom`, `repair`) são extensão desta task — mesmo espírito de como
// T013 já tinha adicionado `sessions:list` sem estar detalhado no plan
// original.

export const PROFILE_CHANNELS = {
  list: 'profiles:list',
  create: 'profiles:create',
  activate: 'profiles:activate',
  doctor: 'profiles:doctor',
  /** T014 — não estava no plan.md original; ver comentário de topo. */
  repair: 'profiles:repair',
  /** T014 — não estava no plan.md original; ver comentário de topo. */
  headroom: 'profiles:headroom',
} as const;

export interface ProfileSummaryDto {
  readonly name: string;
  readonly slug: string;
  readonly isPrimary: boolean;
  readonly active: boolean;
}

export type JunctionIssueDto =
  | { readonly dirName: string; readonly kind: 'missing' }
  | { readonly dirName: string; readonly kind: 'wrong-target'; readonly actualTarget: string; readonly expectedTarget: string };

export interface ProfileDoctorReportDto {
  readonly slug: string;
  readonly junctionIssues: readonly JunctionIssueDto[];
  readonly settingsMissing: boolean;
  readonly claudeMdMissing: boolean;
  readonly mcpServersDrift: boolean;
  readonly healthy: boolean;
}

/**
 * T202 (002-quota-headroom) — uma janela de cota (5h/semana/model:fable) já
 * lida do payload `quota-axi --json`. `percentRemaining` é sempre um número
 * (0-100, "% livre"/restante) quando a janela existe no payload — ausência
 * de janela é modelada por `QuotaWindow | null` no nível de `ProfileQuota`,
 * não por `percentRemaining` opcional aqui.
 */
export interface QuotaWindow {
  readonly percentRemaining: number;
  readonly resetsAt: string | null;
}

/**
 * T202 — substitui o `Record<slug, number | null>` original (um % só, janela
 * não explicitada — motivo do bug "não entendi o que essa cota significa",
 * spec.md problema 2). Contrato IPC: main devolve só `'ok'`/`'unavailable'`
 * (ver `parseQuotaAxiWindows`/`readQuotaAxiQuota` em `main/quota-headroom.ts`);
 * `'loading'` é estado de UI PURO — o renderer usa antes da 1ª resposta do
 * IPC chegar (nunca vem do main, CA-1 "carregando, nunca '—' otimista").
 * `fable` (janela `model:fable`) é revelado só na expansão da linha (CA-2b) —
 * o dado já chega no map, a UI decide quando mostrar.
 */
export interface ProfileQuota {
  readonly status: 'loading' | 'ok' | 'unavailable';
  readonly fiveHour: QuotaWindow | null;
  readonly sevenDay: QuotaWindow | null;
  readonly fable: QuotaWindow | null;
}

/** `Record<slug, ProfileQuota>` — slug ausente = ainda não consultado. */
export type ProfileHeadroomMap = Record<string, ProfileQuota>;

/** API tipada exposta pelo preload em `window.donel.profiles`. */
export interface DonelProfilesApi {
  /** Sempre inclui o Principal (1º item) + os perfis em `~/.claude-profiles/*`. */
  list(): Promise<ProfileSummaryDto[]>;
  /** Cria o perfil (junctions + cópias + bootstrap + merge de mcpServers — spike T001); devolve a lista já atualizada. */
  create(name: string): Promise<ProfileSummaryDto[]>;
  /** Troca o perfil ativo (afeta só sessões `claude` novas, FR-005); devolve a lista já atualizada (campo `active`). */
  activate(slug: string): Promise<ProfileSummaryDto[]>;
  doctor(slug: string): Promise<ProfileDoctorReportDto>;
  /** Recria as junctions quebradas reportadas pelo último `doctor` (ui-spec §6 "Recriar links"); devolve o doctor já re-executado. */
  repair(slug: string): Promise<ProfileDoctorReportDto>;
  /**
   * Leitura sob demanda, paralela, timeout 8s/cache 60s por perfil (FR-012;
   * `unavailable` NUNCA é cacheado — CA-5) — nunca lança, nunca trava
   * esperando todos. T205 (US-C/CA-3): `{ force: true }` ignora o cache de
   * 60s (botão "Atualizar" do dropdown) — omitir o argumento preserva o
   * comportamento anterior (respeita cache).
   */
  headroom(options?: { force?: boolean }): Promise<ProfileHeadroomMap>;
}

const ACCOUNT_NAME_PATTERN = /^Tecnologia Claude (\d+)$/;

/**
 * Puro — extrai o número de "Tecnologia Claude {n}" do nome de exibição do
 * perfil, ou `null` quando o nome não segue essa convenção (perfis de teste
 * como "spike-test"/"e2e-profile-test", ou o Principal). Usado pela UI pra
 * decidir se renderiza o `AccountBadge` do design-system (que hardcoda o
 * texto "Tecnologia Claude {accountNumber}") ou um rótulo genérico com o
 * nome cru — `AccountBadge` NÃO serve pra perfil com nome arbitrário.
 */
export function parseAccountNumber(profileName: string): number | null {
  const match = ACCOUNT_NAME_PATTERN.exec(profileName.trim());
  if (!match) return null;
  return Number(match[1]);
}
