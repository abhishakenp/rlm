/**
 * Configuration schema for iris-rlm.
 *
 * ## Current structure
 *
 * The current Config type in this package is minimal and does not include
 * fields for specifying directories that hold skills, extensions, or prompts.
 * Only CredentialConfig and WorkspaceConfig were defined in other modules.
 *
 * ## Missing fields
 *
 * The following three fields are required to support configurable directories
 * for skills, extensions, and prompts:
 *
 *   skillDirs    ?: string[]  - Directories where skill definition files reside.
 *   extensionDirs ?: string[]  - Directories containing extension configurations.
 *   promptDirs   ?: string[]  - Directories containing prompt templates.
 *
 * ## Proposed schema
 *
 * The Config interface should be expanded to include these fields alongside
 * any existing properties (such as version, enabled flags, etc.).
 */

export interface Config {
  /** Version of the configuration schema. */
  version?: number;

  /** Whether the agent is enabled. */
  enabled?: boolean;

  /** Directories to search for skill definition files. */
  skillDirs?: string[];

  /** Directories to search for extension configuration files. */
  extensionDirs?: string[];

  /** Directories to search for prompt template files. */
  promptDirs?: string[];
}

export default Config;
