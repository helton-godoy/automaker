import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { Page } from "@playwright/test";

const execAsync = promisify(exec);

// Get workspace root for test fixture path
function getWorkspaceRoot(): string {
  const cwd = process.cwd();
  if (cwd.includes("apps/app")) {
    return path.resolve(cwd, "../..");
  }
  return cwd;
}

const WORKSPACE_ROOT = getWorkspaceRoot();
// Use a unique temp dir based on process ID and random string to avoid collisions
const UNIQUE_ID = `${process.pid}-${Math.random().toString(36).substring(2, 9)}`;
const TEST_TEMP_DIR = path.join(WORKSPACE_ROOT, "test", `temp-worktree-tests-${UNIQUE_ID}`);

interface TestRepo {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a temporary git repository for testing
 */
async function createTestGitRepo(): Promise<TestRepo> {
  // Create temp directory if it doesn't exist
  if (!fs.existsSync(TEST_TEMP_DIR)) {
    fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
  }

  const tmpDir = path.join(TEST_TEMP_DIR, `test-repo-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Initialize git repo
  await execAsync("git init", { cwd: tmpDir });
  await execAsync('git config user.email "test@example.com"', { cwd: tmpDir });
  await execAsync('git config user.name "Test User"', { cwd: tmpDir });

  // Create initial commit
  fs.writeFileSync(path.join(tmpDir, "README.md"), "# Test Project\n");
  await execAsync("git add .", { cwd: tmpDir });
  await execAsync('git commit -m "Initial commit"', { cwd: tmpDir });

  // Create main branch explicitly
  await execAsync("git branch -M main", { cwd: tmpDir });

  // Create .automaker directories
  const automakerDir = path.join(tmpDir, ".automaker");
  const featuresDir = path.join(automakerDir, "features");
  fs.mkdirSync(featuresDir, { recursive: true });

  return {
    path: tmpDir,
    cleanup: async () => {
      try {
        // Remove all worktrees first
        const { stdout } = await execAsync("git worktree list --porcelain", {
          cwd: tmpDir,
        }).catch(() => ({ stdout: "" }));

        const worktrees = stdout
          .split("\n\n")
          .slice(1) // Skip main worktree
          .map((block) => {
            const pathLine = block.split("\n").find((line) => line.startsWith("worktree "));
            return pathLine ? pathLine.replace("worktree ", "") : null;
          })
          .filter(Boolean);

        for (const worktreePath of worktrees) {
          try {
            await execAsync(`git worktree remove "${worktreePath}" --force`, {
              cwd: tmpDir,
            });
          } catch {
            // Ignore errors
          }
        }

        // Remove the repository
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (error) {
        console.error("Failed to cleanup test repo:", error);
      }
    },
  };
}

/**
 * Create a feature file in the test repo
 */
function createTestFeature(
  repoPath: string,
  featureId: string,
  featureData: {
    id: string;
    category: string;
    description: string;
    status: string;
    branchName?: string;
    worktreePath?: string;
  }
): void {
  const featuresDir = path.join(repoPath, ".automaker", "features");
  const featureDir = path.join(featuresDir, featureId);

  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(
    path.join(featureDir, "feature.json"),
    JSON.stringify(featureData, null, 2)
  );
}

/**
 * Get list of git worktrees
 */
async function listWorktrees(repoPath: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync("git worktree list --porcelain", {
      cwd: repoPath,
    });

    return stdout
      .split("\n\n")
      .slice(1) // Skip main worktree
      .map((block) => {
        const pathLine = block.split("\n").find((line) => line.startsWith("worktree "));
        return pathLine ? pathLine.replace("worktree ", "") : null;
      })
      .filter(Boolean) as string[];
  } catch {
    return [];
  }
}

/**
 * Get list of git branches
 */
async function listBranches(repoPath: string): Promise<string[]> {
  const { stdout } = await execAsync("git branch --list", { cwd: repoPath });
  return stdout
    .split("\n")
    .map((line) => line.trim().replace(/^[*+]\s*/, ""))
    .filter(Boolean);
}

/**
 * Set up localStorage with a project pointing to our test repo
 */
async function setupProjectWithPath(page: Page, projectPath: string): Promise<void> {
  await page.addInitScript((pathArg: string) => {
    const mockProject = {
      id: "test-project-worktree",
      name: "Worktree Test Project",
      path: pathArg,
      lastOpened: new Date().toISOString(),
    };

    const mockState = {
      state: {
        projects: [mockProject],
        currentProject: mockProject,
        currentView: "board",
        theme: "dark",
        sidebarOpen: true,
        apiKeys: { anthropic: "", google: "" },
        chatSessions: [],
        chatHistoryOpen: false,
        maxConcurrency: 3,
        aiProfiles: [],
      },
      version: 0,
    };

    localStorage.setItem("automaker-storage", JSON.stringify(mockState));

    // Mark setup as complete to skip the setup wizard
    const setupState = {
      state: {
        isFirstRun: false,
        setupComplete: true,
        currentStep: "complete",
        skipClaudeSetup: false,
      },
      version: 0,
    };
    localStorage.setItem("automaker-setup", JSON.stringify(setupState));
  }, projectPath);
}

/**
 * Wait for network to be idle
 */
async function waitForNetworkIdle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

/**
 * Wait for the board view to load
 */
async function waitForBoardView(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="board-view"]', { timeout: 30000 });
}

/**
 * Click the add feature button
 */
async function clickAddFeature(page: Page): Promise<void> {
  await page.click('[data-testid="add-feature-button"]');
  await page.waitForSelector('[data-testid="add-feature-dialog"]', { timeout: 5000 });
}

/**
 * Fill in the add feature dialog
 */
async function fillAddFeatureDialog(
  page: Page,
  description: string,
  options?: { branch?: string; category?: string }
): Promise<void> {
  // Fill description (using the dropzone textarea)
  const descriptionInput = page.locator('[data-testid="add-feature-dialog"] textarea').first();
  await descriptionInput.fill(description);

  // Fill branch if provided (it's a combobox autocomplete)
  if (options?.branch) {
    const branchButton = page.locator('[data-testid="feature-branch-input"]');
    await branchButton.click();
    // Wait for the popover to open
    await page.waitForTimeout(300);
    // Type in the command input
    const commandInput = page.locator('[cmdk-input]');
    await commandInput.fill(options.branch);
    // Press Enter to select/create the branch
    await commandInput.press("Enter");
    // Wait for popover to close
    await page.waitForTimeout(200);
  }

  // Fill category if provided (it's also a combobox autocomplete)
  if (options?.category) {
    const categoryButton = page.locator('[data-testid="feature-category-input"]');
    await categoryButton.click();
    await page.waitForTimeout(300);
    const commandInput = page.locator('[cmdk-input]');
    await commandInput.fill(options.category);
    await commandInput.press("Enter");
    await page.waitForTimeout(200);
  }
}

/**
 * Confirm the add feature dialog
 */
async function confirmAddFeature(page: Page): Promise<void> {
  await page.click('[data-testid="confirm-add-feature"]');
  // Wait for dialog to close
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="add-feature-dialog"]'),
    { timeout: 5000 }
  );
}

// Configure all tests to run serially to prevent interference
test.describe.configure({ mode: "serial" });

// ============================================================================
// Test Suite: Worktree Integration Tests
// ============================================================================
test.describe("Worktree Integration Tests", () => {
  let testRepo: TestRepo;

  test.beforeAll(async () => {
    // Create test temp directory
    if (!fs.existsSync(TEST_TEMP_DIR)) {
      fs.mkdirSync(TEST_TEMP_DIR, { recursive: true });
    }
  });

  test.beforeEach(async () => {
    // Create a fresh test repo for each test
    testRepo = await createTestGitRepo();
  });

  test.afterEach(async () => {
    // Cleanup test repo after each test
    if (testRepo) {
      await testRepo.cleanup();
    }
  });

  test.afterAll(async () => {
    // Cleanup temp directory
    if (fs.existsSync(TEST_TEMP_DIR)) {
      fs.rmSync(TEST_TEMP_DIR, { recursive: true, force: true });
    }
  });

  test("should display worktree selector with main branch", async ({ page }) => {
    await setupProjectWithPath(page, testRepo.path);
    await page.goto("/");
    await waitForNetworkIdle(page);
    await waitForBoardView(page);

    // Verify the worktree selector is visible - look for the "Branch:" label
    const branchLabel = page.getByText("Branch:");
    await expect(branchLabel).toBeVisible({ timeout: 10000 });

    // Verify main branch button is displayed
    const mainBranchButton = page.getByRole("button", { name: "main" });
    await expect(mainBranchButton).toBeVisible({ timeout: 10000 });
  });

  test("should create a worktree via API and verify filesystem", async ({ page }) => {
    await setupProjectWithPath(page, testRepo.path);
    await page.goto("/");
    await waitForNetworkIdle(page);
    await waitForBoardView(page);

    // Create worktree via API directly (simulating the dialog action)
    const branchName = "feature/test-worktree";
    const sanitizedName = branchName.replace(/[^a-zA-Z0-9_-]/g, "-");
    const expectedWorktreePath = path.join(testRepo.path, ".worktrees", sanitizedName);

    // Make the API call directly through the server
    const response = await page.request.post("http://localhost:3008/api/worktree/create", {
      data: {
        projectPath: testRepo.path,
        branchName: branchName,
      },
      headers: {
        "Content-Type": "application/json",
      },
    });

    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect(result.success).toBe(true);

    // Verify worktree was created on filesystem
    const worktreeExists = fs.existsSync(expectedWorktreePath);
    expect(worktreeExists).toBe(true);

    // Verify branch was created
    const branches = await listBranches(testRepo.path);
    expect(branches).toContain(branchName);

    // Verify worktree is listed by git
    const worktrees = await listWorktrees(testRepo.path);
    expect(worktrees.length).toBe(1);
    expect(worktrees[0]).toBe(expectedWorktreePath);
  });

  test("should create two worktrees and list them both", async ({ page }) => {
    await setupProjectWithPath(page, testRepo.path);
    await page.goto("/");
    await waitForNetworkIdle(page);
    await waitForBoardView(page);

    // Create first worktree
    const response1 = await page.request.post("http://localhost:3008/api/worktree/create", {
      data: {
        projectPath: testRepo.path,
        branchName: "feature/worktree-one",
      },
    });
    expect(response1.ok()).toBe(true);

    // Create second worktree
    const response2 = await page.request.post("http://localhost:3008/api/worktree/create", {
      data: {
        projectPath: testRepo.path,
        branchName: "feature/worktree-two",
      },
    });
    expect(response2.ok()).toBe(true);

    // Verify both worktrees exist on filesystem
    const worktrees = await listWorktrees(testRepo.path);
    expect(worktrees.length).toBe(2);

    // Verify branches were created
    const branches = await listBranches(testRepo.path);
    expect(branches).toContain("feature/worktree-one");
    expect(branches).toContain("feature/worktree-two");
  });

  test("should delete a worktree via API and verify cleanup", async ({ page }) => {
    await setupProjectWithPath(page, testRepo.path);
    await page.goto("/");
    await waitForNetworkIdle(page);
    await waitForBoardView(page);

    // First create a worktree
    const branchName = "feature/to-delete";
    const sanitizedName = branchName.replace(/[^a-zA-Z0-9_-]/g, "-");
    const worktreePath = path.join(testRepo.path, ".worktrees", sanitizedName);

    const createResponse = await page.request.post("http://localhost:3008/api/worktree/create", {
      data: {
        projectPath: testRepo.path,
        branchName: branchName,
      },
    });
    expect(createResponse.ok()).toBe(true);

    // Verify it was created
    expect(fs.existsSync(worktreePath)).toBe(true);

    // Now delete it
    const deleteResponse = await page.request.post("http://localhost:3008/api/worktree/delete", {
      data: {
        projectPath: testRepo.path,
        worktreePath: worktreePath,
        deleteBranch: true,
      },
    });
    expect(deleteResponse.ok()).toBe(true);

    // Verify worktree directory is removed
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Verify branch is deleted
    const branches = await listBranches(testRepo.path);
    expect(branches).not.toContain(branchName);
  });

  test("should add a feature to backlog with specific branch", async ({ page }) => {
    await setupProjectWithPath(page, testRepo.path);
    await page.goto("/");
    await waitForNetworkIdle(page);
    await waitForBoardView(page);

    // Create a worktree first
    const branchName = "feature/test-branch";
    await page.request.post("http://localhost:3008/api/worktree/create", {
      data: {
        projectPath: testRepo.path,
        branchName: branchName,
      },
    });

    // Click add feature button
    await clickAddFeature(page);

    // Fill in the feature details
    await fillAddFeatureDialog(page, "Test feature for worktree", {
      branch: branchName,
      category: "Testing",
    });

    // Confirm
    await confirmAddFeature(page);

    // Wait for the feature to appear in the backlog
    await page.waitForTimeout(1000);

    // Verify feature was created with correct branch by checking the filesystem
    const featuresDir = path.join(testRepo.path, ".automaker", "features");
    const featureDirs = fs.readdirSync(featuresDir);
    expect(featureDirs.length).toBeGreaterThan(0);

    // Find and read the feature file
    const featureDir = featureDirs[0];
    const featureFilePath = path.join(featuresDir, featureDir, "feature.json");
    const featureData = JSON.parse(fs.readFileSync(featureFilePath, "utf-8"));

    expect(featureData.description).toBe("Test feature for worktree");
    expect(featureData.branchName).toBe(branchName);
    expect(featureData.status).toBe("backlog");
  });

  test("should filter features by selected worktree", async ({ page }) => {
    // Create the worktrees first
    await execAsync(`git worktree add ".worktrees/feature-worktree-a" -b feature/worktree-a`, {
      cwd: testRepo.path,
    });
    await execAsync(`git worktree add ".worktrees/feature-worktree-b" -b feature/worktree-b`, {
      cwd: testRepo.path,
    });

    await setupProjectWithPath(page, testRepo.path);
    await page.goto("/");
    await waitForNetworkIdle(page);
    await waitForBoardView(page);

    // First click on main to ensure we're on the main branch
    const mainButton = page.getByRole("button", { name: "main" }).first();
    await mainButton.click();
    await page.waitForTimeout(500);

    // Create feature for main branch - don't specify branch, use the default (main)
    await clickAddFeature(page);
    // Just fill description without specifying branch - it should default to main
    const descriptionInput = page.locator('[data-testid="add-feature-dialog"] textarea').first();
    await descriptionInput.fill("Feature for main branch");
    await confirmAddFeature(page);

    // Wait for feature to be created and visible in backlog
    const mainFeatureText = page.getByText("Feature for main branch");
    await expect(mainFeatureText).toBeVisible({ timeout: 10000 });

    // Switch to worktree-a and create a feature there
    const worktreeAButton = page.getByRole("button", { name: /feature\/worktree-a/i });
    await worktreeAButton.click();
    await page.waitForTimeout(500);

    // Main feature should not be visible now
    await expect(mainFeatureText).not.toBeVisible();

    // Create feature for worktree-a - don't specify branch, use the default
    await clickAddFeature(page);
    const descriptionInput2 = page.locator('[data-testid="add-feature-dialog"] textarea').first();
    await descriptionInput2.fill("Feature for worktree A");
    await confirmAddFeature(page);

    // Wait for feature to be visible
    const worktreeAText = page.getByText("Feature for worktree A");
    await expect(worktreeAText).toBeVisible({ timeout: 10000 });

    // Switch to worktree-b and create a feature
    const worktreeBButton = page.getByRole("button", { name: /feature\/worktree-b/i });
    await worktreeBButton.click();
    await page.waitForTimeout(500);

    // worktree-a feature should not be visible
    await expect(worktreeAText).not.toBeVisible();

    await clickAddFeature(page);
    const descriptionInput3 = page.locator('[data-testid="add-feature-dialog"] textarea').first();
    await descriptionInput3.fill("Feature for worktree B");
    await confirmAddFeature(page);

    const worktreeBText = page.getByText("Feature for worktree B");
    await expect(worktreeBText).toBeVisible({ timeout: 10000 });

    // Switch back to main and verify filtering
    await mainButton.click();
    await page.waitForTimeout(500);

    await expect(mainFeatureText).toBeVisible({ timeout: 10000 });
    await expect(worktreeAText).not.toBeVisible();
    await expect(worktreeBText).not.toBeVisible();

    // Switch to worktree-a and verify
    await worktreeAButton.click();
    await page.waitForTimeout(500);

    await expect(worktreeAText).toBeVisible({ timeout: 10000 });
    await expect(mainFeatureText).not.toBeVisible();
    await expect(worktreeBText).not.toBeVisible();
  });

  test("should pre-fill branch when creating feature from selected worktree", async ({ page }) => {
    // Create a worktree first
    const branchName = "feature/pre-fill-test";
    await execAsync(`git worktree add ".worktrees/feature-pre-fill-test" -b ${branchName}`, {
      cwd: testRepo.path,
    });

    await setupProjectWithPath(page, testRepo.path);
    await page.goto("/");
    await waitForNetworkIdle(page);
    await waitForBoardView(page);

    // Wait for worktree selector to load
    await page.waitForTimeout(1000);

    // Click on the worktree to select it
    const worktreeButton = page.getByRole("button", { name: /feature\/pre-fill-test/i });
    await worktreeButton.click();
    await page.waitForTimeout(500);

    // Open add feature dialog
    await clickAddFeature(page);

    // Verify the branch input button shows the selected worktree's branch
    // The branch input is a combobox button, so check its text content
    const branchButton = page.locator('[data-testid="feature-branch-input"]');
    await expect(branchButton).toContainText(branchName, { timeout: 5000 });

    // Close dialog
    await page.keyboard.press("Escape");
  });

  test("should list worktrees via API", async ({ page }) => {
    await setupProjectWithPath(page, testRepo.path);
    await page.goto("/");
    await waitForNetworkIdle(page);

    // Create some worktrees first
    await page.request.post("http://localhost:3008/api/worktree/create", {
      data: {
        projectPath: testRepo.path,
        branchName: "feature/list-test-1",
      },
    });
    await page.request.post("http://localhost:3008/api/worktree/create", {
      data: {
        projectPath: testRepo.path,
        branchName: "feature/list-test-2",
      },
    });

    // List worktrees via API
    const listResponse = await page.request.post("http://localhost:3008/api/worktree/list", {
      data: {
        projectPath: testRepo.path,
        includeDetails: true,
      },
    });

    expect(listResponse.ok()).toBe(true);
    const result = await listResponse.json();
    expect(result.success).toBe(true);
    expect(result.worktrees).toHaveLength(3); // main + 2 worktrees

    // Verify worktree details
    const branches = result.worktrees.map((w: { branch: string }) => w.branch);
    expect(branches).toContain("main");
    expect(branches).toContain("feature/list-test-1");
    expect(branches).toContain("feature/list-test-2");
  });
});
