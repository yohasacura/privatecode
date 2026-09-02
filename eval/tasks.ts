/**
 * The eval set: tasks with an answer the harness can check without believing the model.
 *
 * Every task names what it wants in the words a person would use, and is checked three
 * ways the model never sees: the project builds, HIDDEN xunit tests dropped into the test
 * project afterwards pass (and the existing ones still do), and named strings are present
 * in named files. A bugfix task PLANTS its bug into the copy first, so the fix is measured
 * against a defect that really is there.
 *
 * WindowsOptimizer is the small case (23 files); black-port the owner's real shape (two
 * folders, ~600 files), where the checks are the build plus grep, because its test project
 * is not wired for hidden tests yet.
 */
export interface Plant {
  /** Folder-relative path inside the primary folder. */
  file: string
  from: string
  to: string
  /** How many occurrences `from` must have; the plant refuses anything else. */
  count?: number
}

export interface GrepCheck {
  /** Workspace path as the model sees it (folder-prefixed in a multi-folder shape). */
  file: string
  pattern: string
  /** The pattern must be ABSENT. */
  absent?: boolean
}

export interface Task {
  id: string
  workspace: 'winopt' | 'blackport'
  kind: 'feature' | 'bugfix'
  text: string
  plant?: Plant[]
  /** Directory under eval/hidden/ whose .cs files are copied into the test project. */
  hidden?: string
  grep?: GrepCheck[]
}

export const TASKS: Task[] = [
  // ---- WindowsOptimizer -------------------------------------------------------------------
  {
    id: 'snapshot-savedat',
    workspace: 'winopt',
    kind: 'feature',
    text:
      'Add a `SavedAt` property of type DateTimeOffset to the Snapshot class (src/WinOptimizer/Core/Snapshot.cs) ' +
      'and have SnapshotStore.SaveSnapshot set it to DateTimeOffset.Now before the snapshot is serialised, so a ' +
      'snapshot loaded back says when it was saved. Do not change any other behaviour.',
    hidden: 'snapshot-savedat',
    grep: [{ file: 'src/WinOptimizer/Core/Snapshot.cs', pattern: 'SavedAt' }],
  },
  {
    id: 'appstate-lasterror',
    workspace: 'winopt',
    kind: 'feature',
    text:
      'Add a nullable string property `LastError` (default null) to AppState in src/WinOptimizer/Core/Snapshot.cs. ' +
      'It must persist through SnapshotStore.SaveState and LoadState like the other fields. Nothing else changes.',
    hidden: 'appstate-lasterror',
    grep: [{ file: 'src/WinOptimizer/Core/Snapshot.cs', pattern: 'LastError' }],
  },
  {
    id: 'bug-second-save-fails',
    workspace: 'winopt',
    kind: 'bugfix',
    text:
      'Bug: SnapshotStore.SaveSnapshot works the first time but returns false the second time it is called in the ' +
      'same directory, so the app never updates an existing snapshot. Find the cause in ' +
      'src/WinOptimizer/Services/SnapshotStore.cs and fix it so repeated saves succeed and snapshot.json always ' +
      'holds the latest snapshot, still written atomically.',
    plant: [{
      file: 'src/WinOptimizer/Services/SnapshotStore.cs',
      from: '        File.Move(tmp, path, overwrite: true);',
      to: '        File.Move(tmp, path);',
      count: 1,
    }],
    hidden: 'bug-second-save-fails',
  },
  {
    id: 'bug-risky-services-prechecked',
    workspace: 'winopt',
    kind: 'bugfix',
    text:
      'Bug: in the optimisation plan, risky services such as Tailscale come pre-checked, so one careless click ' +
      'pauses them. Risky services must appear in the plan but UNCHECKED, exactly as risky processes already do; ' +
      'safe services stay checked. Fix it in src/WinOptimizer/Core/OptimizationPlanner.cs.',
    plant: [{
      file: 'src/WinOptimizer/Core/OptimizationPlanner.cs',
      from: '                Description = $"Pause service: {svc.DisplayName}",\n                Risk = risk,\n                IsChecked = risk != RiskLevel.Risky,',
      to: '                Description = $"Pause service: {svc.DisplayName}",\n                Risk = risk,\n                IsChecked = true,',
      count: 1,
    }],
    hidden: 'bug-risky-services-prechecked',
  },
  {
    id: 'planner-max-processes',
    workspace: 'winopt',
    kind: 'feature',
    text:
      'Add an integer setting `MaxProcessesInPlan` to AppConfig (src/WinOptimizer/Core/Config.cs), default 0 ' +
      'meaning unlimited. When it is greater than 0, OptimizationPlanner.BuildPlan keeps only the first ' +
      'MaxProcessesInPlan process items (in the order it already produces them); service, power, brightness and ' +
      'visual-effects items are not affected.',
    hidden: 'planner-max-processes',
    grep: [{ file: 'src/WinOptimizer/Core/Config.cs', pattern: 'MaxProcessesInPlan' }],
  },
  {
    id: 'fallback-brightness-config',
    workspace: 'winopt',
    kind: 'feature',
    text:
      'The fallback restore snapshot (OptimizationPlanner.FallbackRestoreSnapshot) hard-codes 70% brightness. ' +
      'Add an integer setting `FallbackBrightnessPercent` to AppConfig (src/WinOptimizer/Core/Config.cs), default ' +
      '70, and make FallbackRestoreSnapshot use it for BrightnessPercent.',
    hidden: 'fallback-brightness-config',
    grep: [{ file: 'src/WinOptimizer/Core/OptimizationPlanner.cs', pattern: 'FallbackBrightnessPercent' }],
  },
  {
    id: 'logger-rotation',
    workspace: 'winopt',
    kind: 'feature',
    text:
      'Give FileLogger (src/WinOptimizer/Services/FileLogger.cs) simple size-based rotation. Change the constructor ' +
      'to `FileLogger(string? baseDir = null, long maxBytes = 1_048_576)`. Before writing a line, if log.txt is ' +
      'larger than maxBytes, close it, move it to log.1.txt (replacing any previous log.1.txt) and start a fresh ' +
      'log.txt. Existing callers that pass only baseDir must keep working.',
    hidden: 'logger-rotation',
    grep: [{ file: 'src/WinOptimizer/Services/FileLogger.cs', pattern: 'log\\.1\\.txt' }],
  },
  {
    id: 'bug-relaycommand-disabled',
    workspace: 'winopt',
    kind: 'bugfix',
    text:
      'Bug: every button bound to a RelayCommand created WITHOUT a canExecute predicate is disabled. A command ' +
      'with no predicate must be executable. Fix src/WinOptimizer/ViewModels/RelayCommand.cs — both the ' +
      'non-generic and the generic class — without changing the behaviour when a predicate is given.',
    plant: [{
      file: 'src/WinOptimizer/ViewModels/RelayCommand.cs',
      from: '_canExecute?.Invoke() ?? true',
      to: '_canExecute?.Invoke() ?? false',
      count: 2,
    }],
    hidden: 'bug-relaycommand-disabled',
  },
  {
    id: 'converter-bool-visibility',
    workspace: 'winopt',
    kind: 'feature',
    text:
      'Add a WPF value converter `BoolToVisibilityConverter` in the namespace WinOptimizer.Converters, in a new ' +
      'file src/WinOptimizer/Converters/BoolToVisibilityConverter.cs, following the style of the converters ' +
      'already there: Convert maps true to Visibility.Visible and anything else to Visibility.Collapsed; ' +
      'ConvertBack maps Visibility.Visible to true and anything else to false.',
    hidden: 'converter-bool-visibility',
    grep: [{ file: 'src/WinOptimizer/Converters/BoolToVisibilityConverter.cs', pattern: 'class BoolToVisibilityConverter' }],
  },
  {
    id: 'snapshot-servicecount',
    workspace: 'winopt',
    kind: 'feature',
    text:
      'Add a read-only computed property `ServiceCount` (int) to Snapshot in src/WinOptimizer/Core/Snapshot.cs ' +
      'that returns Services.Count. It must NOT be written to JSON when a snapshot is serialised with ' +
      'System.Text.Json (mark it accordingly), and deserialising older snapshot files must keep working.',
    hidden: 'snapshot-servicecount',
    grep: [{ file: 'src/WinOptimizer/Core/Snapshot.cs', pattern: 'ServiceCount' }],
  },

  // ---- black-port: two folders, ~600 files --------------------------------------------------
  {
    id: 'bp-count-by-status',
    workspace: 'blackport',
    kind: 'feature',
    text:
      'In the backend, add an endpoint GET api/crm/leads/count-by-status to LeadsController. For the leads the ' +
      'current user is allowed to see — everyone with LeadsViewAll sees all of them, anyone else only the leads ' +
      'assigned to them, and merged leads never count — return a list of { statusId, statusName, count }, ordered ' +
      'by count descending. Define the DTO as a record LeadStatusCountDto in ' +
      'BlackPort.Application/DTOs/Crm/LeadDtos.cs beside the other lead DTOs. Do not change any existing endpoint ' +
      'and do not touch the frontend.',
    grep: [
      { file: 'backend/BlackPort.Api/Controllers/Crm/LeadsController.cs', pattern: 'count-by-status' },
      { file: 'backend/BlackPort.Application/DTOs/Crm/LeadDtos.cs', pattern: 'record LeadStatusCountDto' },
    ],
  },
  {
    id: 'bp-quote-cost-total',
    workspace: 'blackport',
    kind: 'feature',
    text:
      'In the backend domain, add a read-only computed property `CostTotal` (decimal) to the Quote entity in ' +
      'BlackPort.Domain/Entities/Quote.cs that returns the sum of Amount over its Lines (currencies are not ' +
      'converted; just sum). It must not become a database column: mark it so that Entity Framework ignores it ' +
      '([NotMapped]). Nothing else changes.',
    grep: [
      { file: 'backend/BlackPort.Domain/Entities/Quote.cs', pattern: 'CostTotal' },
      { file: 'backend/BlackPort.Domain/Entities/Quote.cs', pattern: 'NotMapped' },
    ],
  },
  {
    id: 'bp-quote-is-expired',
    workspace: 'blackport',
    kind: 'feature',
    text:
      'In BlackPort.Domain/Entities/Quote.cs add a read-only computed property `IsExpired` (bool): true when ' +
      'ValidUntilUtc has a value and that value is earlier than DateTime.UtcNow, false otherwise. Mark it ' +
      '[NotMapped] so Entity Framework ignores it, the same way IsDeleted is not a column. Nothing else changes.',
    grep: [
      { file: 'backend/BlackPort.Domain/Entities/Quote.cs', pattern: 'IsExpired' },
      { file: 'backend/BlackPort.Domain/Entities/Quote.cs', pattern: 'ValidUntilUtc' },
    ],
  },
  {
    id: 'bp-dashboard-lead-sources',
    workspace: 'blackport',
    kind: 'feature',
    text:
      'In the backend, add an endpoint GET api/crm/dashboard/lead-sources to DashboardController ' +
      '(BlackPort.Api/Controllers/Crm/DashboardController.cs) returning, for the leads the current user may see ' +
      '(the same visibility rule the rest of the CRM uses) and excluding merged leads, a list of ' +
      '{ source, count } ordered by count descending, where source is the LeadSource enum name as a string. Put ' +
      'the DTO record LeadSourceCountDto in BlackPort.Application/DTOs/Crm/DashboardDtos.cs. Do not change any ' +
      'existing endpoint.',
    grep: [
      { file: 'backend/BlackPort.Api/Controllers/Crm/DashboardController.cs', pattern: 'lead-sources' },
      { file: 'backend/BlackPort.Application/DTOs/Crm/DashboardDtos.cs', pattern: 'record LeadSourceCountDto' },
    ],
  },
  {
    id: 'bp-frontend-privacy-hint',
    workspace: 'blackport',
    kind: 'feature',
    text:
      'In the frontend, add a translation key `privacyHint` to the contact form\'s messages in both ' +
      'frontend/locales/en.json ("We never share your details with anyone.") and frontend/locales/uk.json ' +
      '(a natural Ukrainian translation), under the same object the contact form already reads its other ' +
      'strings from, and render it as a small line below the contact form in ' +
      'frontend/src/app/[locale]/contact/page.tsx using the translation mechanism that page already uses. Do not ' +
      'touch the backend.',
    grep: [
      { file: 'frontend/locales/en.json', pattern: 'privacyHint' },
      { file: 'frontend/locales/uk.json', pattern: 'privacyHint' },
      { file: 'frontend/src/app/[locale]/contact/page.tsx', pattern: 'privacyHint' },
    ],
  },
]
