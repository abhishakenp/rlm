import { GoogleGenAI } from "@google/genai";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
} from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { getEnvApiKey } from "../env-api-keys.js";

export interface GoogleImageOptions extends StreamOptions {
	numberOfImages?: number;
	aspectRatio?: "1:1" | "9:16" | "16:9" | "4:3" | "3:4";
	mimeType?: "image/png" | "image/jpeg" | "image/webp";
	imageSize?: "1024" | "2048";
}

function extractContent(message: AssistantMessage): (TextContent | ImageContent)[] {
	const content = message.content;
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (Array.isArray(content)) {
		return content;
	}
	return [];
}

function buildPrompt(context: Context): string {
	const parts: string[] = [];

	for (const message of context.messages) {
		if (message.role === "user") {
			const content = extractContent(message as AssistantMessage);
			for (const item of content) {
				if (item.type === "text") {
					parts.push(item.text);
				}
			}
		}
	}

	return parts.join("\n").trim() || "Generate an image";
}

export const streamGoogleImage: StreamFunction<"google-image-generation", GoogleImageOptions> = (
	model: Model<"google-image-generation">,
	context: Context,
	options?: GoogleImageOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-image-generation" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const client = new GoogleGenAI({ apiKey });

			// Build the prompt from context messages
			const prompt = buildPrompt(context);

			// Build image config
			const config: Record<string, unknown> = {};
			if (options?.numberOfImages !== undefined) {
				config.numberOfImages = options.numberOfImages;
			}
			if (options?.aspectRatio !== undefined) {
				config.aspectRatio = options.aspectRatio;
			}
			if (options?.mimeType !== undefined) {
				config.outputMimeType = options.mimeType;
			}
			if (options?.imageSize !== undefined) {
				config.imageSize = options.imageSize;
			}

			stream.push({ type: "start", partial: output });

			// Call Gemini image generation API
			const response = await client.models.generateImages({
				model: model.id,
				prompt,
				config: Object.keys(config).length > 0 ? config : undefined,
			});

			// Process generated images
			const generatedImages = response.generatedImages || [];
			for (const genImage of generatedImages) {
				const imageData = genImage.image?.imageBytes;
				const mimeType = genImage.image?.mimeType || options?.mimeType || "image/png";

				if (imageData) {
					const imageContent: ImageContent = {
						type: "image",
						data: imageData,
						mimeType,
					};
					output.content.push(imageContent);
					stream.push({ type: "content", content: imageContent, partial: output });
				}
			}

			output.stopReason = generatedImages.length > 0 ? "stop" : "error";
			stream.push({ type: "stop", partial: output });
			stream.end(output);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			output.stopReason = "error";
			output.errorMessage = errorMessage;
			stream.push({ type: "error", reason: "error", error: output });
			stream.end(output);
		}
	})();

	return stream;
};

export const streamSimpleGoogleImage: StreamFunction<"google-image-generation", SimpleStreamOptions> = (
	model: Model<"google-image-generation">,
	context: Context,
	options?: SimpleStreamOptions,
) => {
	return streamGoogleImage(model, context, options);
};
