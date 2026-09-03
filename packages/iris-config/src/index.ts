import { Service } from "@deepseek-ai/cordis";

/**
 * @rlm/iris-config — configuration introspection for composed rows.
 *
 * Exposes the same row description logic as rlm-compose, but focused on
 * the config schema that each row accepts.
 */

export interface Field {
	key: string;
	type: string;
	description?: string;
	default?: unknown;
}

export interface Row {
	id: string;
	plugin: string;
	config: Record<string, unknown>;
	disabled: boolean;
	state?: string;
	/** Fields this plugin documents. */
	accepts?: Field[];
}

export interface IrisConfigConfig {
	/** Show all rows including disabled ones. */
	showDisabled?: boolean;
	/** Filter rows by plugin name. */
	filter?: string;
}

export const configFields: Field[] = [
	{ key: "showDisabled", type: "boolean", description: "Include disabled rows in output." },
	{ key: "filter", type: "string", description: "Filter rows by plugin name (substring match)." },
];

export class IrisConfigService extends Service {
	static inject = ["rlmCompose"] as const;
	static provide = "irisConfig" as const;

	declare config: IrisConfigConfig;

	private compose: any;

	constructor(ctx: any, config: IrisConfigConfig = {}) {
		super(ctx, undefined as any);
		this.config = config;
		this.compose = ctx.get("rlmCompose");
	}

	/**
	 * Describe a row's configuration schema.
	 *
	 * Returns the Row object with accepts field populated from the row's
	 * configFields export.
	 *
	 * @param id - The row identifier
	 * @returns Row with accepts populated
	 */
	async describe(id: string): Promise<Row> {
		return this.compose.describe(id);
	}

	/**
	 * List all rows with their config schemas.
	 *
	 * @param options - Filter options
	 * @returns Array of Row objects
	 */
	async rows(options?: { showDisabled?: boolean; filter?: string }): Promise<Row[]> {
		const rows = this.compose.rows();
		const opts = { ...this.config, ...options };

		return rows.filter((row: Row) => {
			if (!opts.showDisabled && row.disabled) return false;
			if (opts.filter && !row.plugin.includes(opts.filter)) return false;
			return true;
		});
	}
}

export default IrisConfigService;
