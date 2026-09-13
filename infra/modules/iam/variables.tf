variable "project_id" {
  type        = string
  description = "Environment project to apply IAM on."
}

variable "deploy_sa_email" {
  type        = string
  description = "Email of the CI deploy service account (created in the bootstrap stack)."
}

variable "deploy_sa_roles" {
  type        = list(string)
  description = "Project-level roles granted to the deploy SA so firebase deploy succeeds."
  default = [
    "roles/firebase.admin",
    "roles/firebaseapphosting.admin",
    # Prod rolls out App Hosting via the CLI (deploy-prod.yml:
    # `apphosting:rollouts:create … --git-commit $GITHUB_SHA`). Creating the
    # rollout reads the Developer Connect git repository link + git refs
    # (developerconnect.admin) AND fetches a repo read token
    # (developerconnect.gitRepositoryLinks.fetchReadToken, which admin does NOT
    # include — only readTokenAccessor does). firebaseapphosting.admin covers
    # neither, so BOTH roles below are required; without them the prod rollout
    # 403s (first on .get, then on :fetchReadToken). (Staging/sandbox use
    # auto-rollout and never exercise this, but the grants are harmless there.)
    "roles/developerconnect.admin",
    "roles/developerconnect.readTokenAccessor",
    "roles/cloudfunctions.developer",
    "roles/run.admin",
    # Scheduled functions (onSchedule) create/update Cloud Scheduler jobs;
    # task-queue functions (onTaskDispatched) create/update Cloud Tasks queues.
    # Without these the deploy 403s on dailyTasks/weeklyReports/executeDelayedRule.
    "roles/cloudscheduler.admin",
    "roles/cloudtasks.admin",
    # Pub/Sub-TRIGGERED functions. `handleBudgetNotification` is the first one
    # this codebase has (v2 `onMessagePublished`), and the deploy failed on it
    # with "Unexpected error creating Pub/Sub topic" — a 403, because nothing
    # here had ever needed a Pub/Sub role: v2 `onSchedule` targets the function
    # over HTTP through Cloud Scheduler and never touches a topic.
    #
    # ADMIN rather than editor: firebase-tools creates the topic AND wires the
    # Eventarc trigger's subscription to it, which reaches topic IAM —
    # `roles/pubsub.editor` has no `pubsub.topics.setIamPolicy`. This SA already
    # holds run.admin, cloudtasks.admin and resourcemanager.projectIamAdmin, so
    # this is not a step up in posture; it is the same deploy identity gaining
    # the one product it was missing.
    "roles/pubsub.admin",
    "roles/cloudbuild.builds.editor",
    "roles/artifactregistry.admin",
    "roles/iam.serviceAccountUser",
    "roles/datastore.indexAdmin",
    "roles/firebaserules.admin",
    "roles/eventarc.developer",
    "roles/secretmanager.viewer",
    "roles/serviceusage.serviceUsageConsumer",
    "roles/resourcemanager.projectIamAdmin",
  ]
}

variable "extra_token_creator_sa_emails" {
  type        = list(string)
  description = <<-DESC
    Service accounts that must be able to sign blobs AS THEMSELVES, granted
    roles/iam.serviceAccountTokenCreator on their own identity.

    Needed by any function calling admin.auth().createCustomToken() — a gen2
    function has no private key, so the Admin SDK signs via the IAM signBlob
    API, which this role authorises. roles/editor does NOT include signBlob,
    which is why the omission is invisible until a token mint is attempted.

    In practice this is the DEFAULT COMPUTE SA: functions deploy without an
    explicit serviceAccount (setGlobalOptions sets only the region), so they run
    as it rather than as the dedicated linyup-functions SA — the same reason the
    secrets module takes extra_accessor_members.
  DESC
  default     = []
}
