import { getInput, setOutput, setFailed } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import shellac from "shellac";
import { fetch } from "undici";
import { env } from "process";
import type { Deployment } from '@cloudflare/types';

// TODO: Add Project to @cloudflare/types
interface Project {
  name: string;
  production_branch: string; 
}

try {
  const apiToken = getInput("apiToken", { required: true });
  const accountId = getInput("accountId", { required: true });
  const projectName = getInput("projectName", { required: true });
  const directory = getInput("directory", { required: true });
  const gitHubToken = getInput("gitHubToken", { required: false });
  const branch = getInput("branch", { required: false }) || env.GITHUB_REF_NAME;
  const commitDirty = Boolean(getInput("commitDirty", { required: false }));
  const deploymentName = getInput("deploymentName", { required: false });
  
  const getProject = async () => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    const { result } = await response.json() as { result: Project };
    return result;
  }
  
  const createPagesDeployment = async () => {
    // TODO: Replace this with an API call to wrangler so we can get back a full deployment response object
    await shellac`
    $ export CLOUDFLARE_API_TOKEN="${apiToken}"
    if ${accountId} {
      $ export CLOUDFLARE_ACCOUNT_ID="${accountId}"
    }
  
    $$ npx wrangler@2 pages publish "${directory}" --project-name="${projectName}" --branch="${branch}" --commit-dirty=${commitDirty}
    `;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${projectName}/deployments`,
      { headers: { Authorization: `Bearer ${apiToken}` } }
    );
    const {
      result: [deployment],
    } = (await response.json()) as { result: Deployment[] };

    return deployment;
  };

  (async () => {
    const pagesDeployment = await createPagesDeployment();

    const alias = (
      pagesDeployment.aliases?.[0] ||
      pagesDeployment.url.replace(
        pagesDeployment.short_id,
        (branch || pagesDeployment.deployment_trigger.metadata.branch).toLowerCase().replace(/\s+/g, '').replace(/[^a-z\d]/g, '-')
      )
    )

    console.log({aliases: pagesDeployment.aliases, branch , metadata: pagesDeployment.deployment_trigger.metadata, alias})

    setOutput("id", pagesDeployment.id);
    setOutput("url", pagesDeployment.url);
    setOutput("environment", pagesDeployment.environment);
    setOutput("alias", alias);

    if (gitHubToken) {
      const project = await getProject();

      const productionEnvironment = branch === project.production_branch;

      const environmentName = productionEnvironment
        ? deploymentName || pagesDeployment.environment
        : `${deploymentName || pagesDeployment.environment} (${branch})`;

      const octokit = getOctokit(gitHubToken);
    
      const gitHubDeployment = await octokit.rest.repos.createDeployment({
        owner: context.repo.owner,
        repo: context.repo.repo,
        ref: context.ref,
        auto_merge: false,
        description: "Cloudflare Pages",
        required_contexts: [],
        environment: environmentName,
        production_environment: productionEnvironment,
      });
  
      if (gitHubDeployment.status === 201) {
        await octokit.rest.repos.createDeploymentStatus({
          owner: context.repo.owner,
          repo: context.repo.repo,
          deployment_id: gitHubDeployment.data.id,
          // @ts-ignore
          environment: environmentName,
          environment_url: pagesDeployment.url,
          production_environment: productionEnvironment,
          log_url: `https://dash.cloudflare.com/${accountId}/pages/view/${projectName}/${pagesDeployment.id}`,
          description: "Cloudflare Pages",
          state: "success",
        });
      }
    }
  })();
} catch (thrown) {
  setFailed(thrown.message);
}
