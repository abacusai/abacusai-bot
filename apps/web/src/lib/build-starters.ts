/**
 * Projects people start the app with: the first-run screen draws them under
 * category tabs, and the start page offers the build ones again after a pick.
 * One list, so a project added here reaches both.
 *
 * - `build`: its prompt waits in the box for Send, like a typed ask.
 * - `bot`: makes a bot from the template catalog that keeps doing the work.
 *
 * i18n: sessions.start.build.<id>.name / .detail, and .prompt for `build`.
 */
export type ProjectCategory = "business" | "websites" | "games" | "automate";

/** The first-run screen's tabs: Popular, then each category. i18n: onboarding.firstRun.projects.<id> */
export type ProjectTab = "popular" | ProjectCategory;

export const PROJECT_TABS: readonly ProjectTab[] = [
  "popular",
  "business",
  "websites",
  "games",
  "automate",
];

export type ProjectStarter =
  | { id: string; kind: "build"; categories: readonly ProjectCategory[] }
  | {
      id: string;
      kind: "bot";
      templateId: string;
      categories: readonly ProjectCategory[];
    };

/** In the order Popular shows them. */
export const PROJECT_STARTERS: readonly ProjectStarter[] = [
  { id: "orders-system", kind: "build", categories: ["business"] },
  {
    id: "business-site",
    kind: "build",
    categories: ["business", "websites"],
  },
  {
    id: "lead-finder",
    kind: "bot",
    templateId: "lead-finder",
    categories: ["business", "automate"],
  },
  { id: "my-game", kind: "build", categories: ["games"] },
  {
    id: "morning-inbox",
    kind: "bot",
    templateId: "chief-of-staff",
    categories: ["business", "automate"],
  },
  { id: "portfolio-site", kind: "build", categories: ["websites"] },
  {
    id: "numbers-dashboard",
    kind: "build",
    categories: ["business", "automate"],
  },
  { id: "shop-page", kind: "build", categories: ["business", "websites"] },
  { id: "simple-game", kind: "build", categories: ["games"] },
];

/** Tiles a tab shows: two rows of the screen's two columns. */
export const PROJECT_SLOTS = 6;

/**
 * The projects a tab shows, in catalog order. Popular is the catalog's head.
 * `hide` drops projects already on the screen another way (the morning inbox
 * beside a Chief of Staff already reading it).
 */
export const projectsIn = (
  tab: ProjectTab,
  hide: readonly string[] = []
): ProjectStarter[] =>
  PROJECT_STARTERS.filter(
    (project) =>
      !hide.includes(project.id) &&
      (tab === "popular" || project.categories.includes(tab))
  ).slice(0, PROJECT_SLOTS);

/** The build projects, as the start page offers them after a build pick. */
export const BUILD_PROJECTS = PROJECT_STARTERS.filter(
  (project) => project.kind === "build"
);

/** The sample a plain "Start building" (and the tour) leaves in the box. */
export const BUILD_SAMPLE_ID = "portfolio-site";

export const GITHUB_CONNECTOR_ID = "abacus-githubbot";

/**
 * Coding work for an account with GitHub connected: they lead the start page.
 * Prompts are localized the same way. i18n: sessions.start.code.<id>.name / .detail / .prompt
 */
export const CODE_STARTER_IDS = [
  "fix-a-bug",
  "add-a-feature",
  "review-my-prs",
] as const;

/**
 * The first-run GitHub pick's task, sent at once: one that does real work
 * before asking anything (the others start by asking what to fix or add).
 */
export const GITHUB_FIRST_TASK: (typeof CODE_STARTER_IDS)[number] =
  "review-my-prs";
