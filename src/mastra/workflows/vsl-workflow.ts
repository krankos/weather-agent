import { openai } from "@ai-sdk/openai";
import { generateObject } from "ai";
import { createWorkflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import ytdl, { type videoFormat } from "@distube/ytdl-core";
import fs from "node:fs";
import path from "node:path";
import { createClient } from "@deepgram/sdk";

// VSL Section schema - defines the structure for each section of the VSL
const vslSectionSchema = z.object({
  title: z.string().describe("The title or heading of this section"),
  content: z.string().describe("The actual content of this section"),
  purpose: z
    .enum([
      "hook",
      "problem_identification",
      "solution_introduction",
      "credibility_building",
      "social_proof",
      "objection_handling",
      "urgency_scarcity",
      "call_to_action",
      "bonus_offer",
      "guarantee",
      "summary_recap",
    ])
    .describe("The marketing purpose this section serves"),
  tone: z
    .enum([
      "urgent",
      "empathetic",
      "authoritative",
      "conversational",
      "persuasive",
      "educational",
      "emotional",
      "logical",
      "testimonial",
      "reassuring",
    ])
    .describe("The tone or emotional approach used in this section"),
  keyPoints: z
    .array(z.string())
    .describe("Key points or takeaways from this section"),
  timestamps: z
    .object({
      start: z.string().describe("Approximate start time in the transcript"),
      end: z.string().describe("Approximate end time in the transcript"),
    })
    .nullable()
    .describe("Estimated time markers if identifiable"),
});

// Complete VSL schema
const vslScriptSchema = z.object({
  overallStrategy: z
    .string()
    .describe("The overall marketing strategy and approach used"),
  targetAudience: z
    .string()
    .describe("The intended target audience for this VSL"),
  mainOffer: z
    .string()
    .describe("The primary product, service, or offer being promoted"),
  sections: z
    .array(vslSectionSchema)
    .describe("Array of structured VSL sections"),
  effectiveness: z
    .object({
      strengths: z.array(z.string()).describe("What makes this VSL effective"),
      improvements: z
        .array(z.string())
        .describe("Potential areas for improvement"),
      overallRating: z
        .number()
        .min(1)
        .max(10)
        .describe("Overall effectiveness rating out of 10"),
    })
    .describe("Analysis of the VSL's effectiveness"),
});

if (!process.env.DG_API_KEY) {
  throw new Error("DEEPGRAM_API_KEY environment variable is required");
}

const downloadVideo = async ({
  videoId,
}: {
  videoId: string;
}): Promise<{ videoFileName: string }> => {
  console.log(`Downloading video with ID: ${videoId}`);
  const outputDir = "./video/";

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    ytdl
      .getInfo(videoUrl)
      .then((info) => {
        const title = info.videoDetails.title
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "_");

        const audioFormats = info.formats.filter(
          (format: videoFormat) => format.hasAudio && !format.hasVideo
        );

        if (audioFormats.length === 0) {
          throw new Error("No audio-only formats available");
        }

        const bestAudioFormat = audioFormats.sort(
          (a: videoFormat, b: videoFormat) =>
            (b.audioBitrate || 0) - (a.audioBitrate || 0)
        )[0];

        const container = bestAudioFormat.container || "webm";
        const fileName = `${title}_${videoId}.${container}`;
        const filePath = path.join(outputDir, fileName);

        console.log(
          `Downloading audio (${bestAudioFormat.audioBitrate}kbps ${container}): ${title}`
        );

        const audioStream = ytdl(videoUrl, {
          filter: "audioonly",
          quality: "highestaudio",
        });
        const writeStream = fs.createWriteStream(filePath);

        let downloadedBytes = 0;
        const contentLength = parseInt(
          info.formats.find((f: videoFormat) => f.hasAudio && !f.hasVideo)
            ?.contentLength || "0"
        );

        audioStream.on("data", (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (contentLength > 0) {
            const percent = ((downloadedBytes / contentLength) * 100).toFixed(
              1
            );
            console.log(`${percent}% downloaded`);
          }
        });

        audioStream.on("error", (error: Error) => {
          console.error("Download error:", error);
          reject(error);
        });

        writeStream.on("error", (error: Error) => {
          console.error("Write error:", error);
          reject(error);
        });

        writeStream.on("finish", () => {
          console.log(`Downloaded ${fileName}`);
          resolve({ videoFileName: filePath });
        });

        audioStream.pipe(writeStream);
      })
      .catch((error) => {
        console.error("Error getting video info:", error);
        reject(error);
      });
  });
};

const getTranscript = async ({
  videoFileName,
}: {
  videoFileName: string;
}): Promise<{
  transcript: string;
  transcriptFileName: string;
  videoFileDeleted: boolean;
}> => {
  console.log(`Starting transcription for: ${videoFileName}`);

  const deepgram = createClient(process.env.DG_API_KEY);

  const { result } = await deepgram.listen.prerecorded.transcribeFile(
    fs.createReadStream(videoFileName),
    {
      punctuate: true,
    }
  );

  if (!result?.results?.channels[0]?.alternatives[0]) {
    throw new Error("No transcription results found");
  }

  const transcript = result.results.channels[0].alternatives[0].transcript;

  const outputDir = "./transcription/";
  const baseFileName = path.basename(
    videoFileName,
    path.extname(videoFileName)
  );
  const transcriptFileName = path.join(
    outputDir,
    `${baseFileName}_transcript.txt`
  );

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(transcriptFileName, transcript, "utf8");
  console.log(`Transcript saved to: ${transcriptFileName}`);

  fs.unlinkSync(videoFileName);

  return {
    transcript,
    transcriptFileName,
    videoFileDeleted: true,
  };
};

const downloadVideoStep = createStep({
  id: "download-video",
  description: "Downloads a YouTube video by its ID (skips if already exists)",
  inputSchema: z.object({
    videoId: z.string().describe("The ID of the YouTube video to download"),
    exists: z
      .boolean()
      .describe("Whether the video already exists in database"),
    videoRecord: z.any().nullable().describe("Existing video record if found"),
    keywords: z
      .array(z.string())
      .nullable()
      .describe("Keywords to pass to Deepgram for transcription"),
  }),
  outputSchema: z.object({
    videoFileName: z
      .string()
      .nullable()
      .describe("The path to the downloaded video file"),
    videoId: z.string().describe("The ID of the YouTube video"),
    exists: z
      .boolean()
      .describe("Whether the video already exists in database"),
    videoRecord: z.any().nullable().describe("Existing video record if found"),
    keywords: z
      .array(z.string())
      .nullable()
      .describe("Keywords to pass to Deepgram for transcription"),
  }),
  execute: async ({ inputData }) => {
    if (inputData.exists) {
      console.log(
        `Video ${inputData.videoId} already exists, skipping download`
      );
      return {
        videoId: inputData.videoId,
        exists: true,
        videoRecord: inputData.videoRecord,
        keywords: inputData.keywords,
        videoFileName: null,
      };
    }

    const result = await downloadVideo({ videoId: inputData.videoId });
    return {
      ...result,
      videoId: inputData.videoId,
      exists: false,
      keywords: inputData.keywords,
    };
  },
});

const getTranscriptStep = createStep({
  id: "get-transcript",
  description:
    "Gets the transcript of a downloaded YouTube video (skips if already exists)",
  inputSchema: z.object({
    videoFileName: z
      .string()
      .nullable()
      .describe("The path to the downloaded video file"),
    videoId: z.string().describe("The ID of the YouTube video"),
    exists: z
      .boolean()
      .describe("Whether the video already exists in database"),
    videoRecord: z.any().nullable().describe("Existing video record if found"),
    keywords: z
      .array(z.string())
      .nullable()
      .describe("Keywords to pass to Deepgram for transcription"),
  }),
  outputSchema: z.object({
    transcript: z.string().describe("The transcribed text from the video"),
    transcriptFileName: z
      .string()
      .describe("The path to the saved transcript file"),
    videoFileDeleted: z
      .boolean()
      .describe("Whether the original video file was deleted"),
    videoId: z.string().describe("The ID of the YouTube video"),
  }),
  execute: async ({ inputData }) => {
    let transcript: string;
    let transcriptFileName: string;
    let videoFileDeleted: boolean;

    if (inputData.exists && inputData.videoRecord) {
      console.log(
        `Video ${inputData.videoId} already exists, using existing transcript`
      );
      transcript = inputData.videoRecord.fullTranscript;
      transcriptFileName = inputData.videoRecord.transcriptFileName || "";
      videoFileDeleted = true;
    } else {
      if (!inputData.videoFileName) {
        throw new Error("Video file name is required for transcription");
      }

      const result = await getTranscript({
        videoFileName: inputData.videoFileName,
      });

      transcript = result.transcript;
      transcriptFileName = result.transcriptFileName;
      videoFileDeleted = result.videoFileDeleted;
    }

    // Check if transcript is empty or contains only whitespace
    if (!transcript || transcript.trim().length === 0) {
      throw new Error(
        `Transcription failed or returned empty transcript for video ${inputData.videoId}. Cannot proceed with VSL analysis.`
      );
    }

    console.log(`Transcript validated: ${transcript.length} characters`);

    return {
      transcript,
      transcriptFileName,
      videoFileDeleted,
      videoId: inputData.videoId,
    };
  },
});

const extractVSLStep = createStep({
  id: "extract-vsl-script",
  description:
    "Analyzes the transcript to extract a structured VSL script with sections, purposes, and tones",
  inputSchema: z.object({
    transcript: z.string().describe("The video transcript text"),
    transcriptFileName: z
      .string()
      .describe("The path to the saved transcript file"),
    videoFileDeleted: z
      .boolean()
      .describe("Whether the original video file was deleted"),
    videoId: z.string().describe("The ID of the YouTube video"),
  }),
  outputSchema: z.object({
    transcript: z.string().describe("The video transcript text"),
    transcriptFileName: z
      .string()
      .describe("The path to the saved transcript file"),
    videoFileDeleted: z
      .boolean()
      .describe("Whether the original video file was deleted"),
    videoId: z.string().describe("The ID of the YouTube video"),
    vslScript: vslScriptSchema.describe("Extracted and structured VSL script"),
  }),
  execute: async ({ inputData }) => {
    console.log("Extracting VSL script structure from transcript...");

    const { object: vslScript } = await generateObject({
      model: openai("o3-mini"),
      schema: vslScriptSchema,
      prompt: `You are an expert VSL (Video Sales Letter) analyst. Analyze this video transcript and extract a comprehensive VSL script structure.

A VSL is an ultra-short marketing video (typically 30 seconds) designed to sell a product or service instantly and effectively. It follows a hyper-focused format with each section serving critical psychological and marketing purposes in minimal time.

Transcript: ${inputData.transcript}

Your task is to:

1. **Identify the overall strategy** - What marketing approach is being used?
2. **Determine the target audience** - Who is this VSL speaking to?
3. **Extract the main offer** - What product/service is being sold?
4. **Break down into sections** - Divide the content into logical sections with:
   - Clear titles for each section
   - The actual content/script for that section (hyper-concise for 30-second total)
   - The marketing purpose it serves (hook, problem identification, solution, etc.)
   - The tone being used (urgent, empathetic, authoritative, etc.)
   - Key points made in that section
   - Approximate timestamps if you can identify them

5. **Analyze effectiveness** - Evaluate what works well and what could be improved

Focus on identifying the 30-SECOND VSL structure:
- **Hook (0-5 seconds)** - Must grab attention instantly with a powerful statement or question
- **Problem (5-12 seconds)** - Single most painful problem, stated dramatically
- **Solution (12-22 seconds)** - Quick benefit-focused solution presentation with proof
- **CTA (22-30 seconds)** - Urgent, clear call-to-action with immediate next step

Critical elements for 30-second format:
- What credibility elements are used? - Must be lightning-fast proof points
- How does it handle objections? - Only the #1 objection, addressed in seconds
- What social proof is provided? - Quick numbers or testimonial snippets
- How does it create urgency? - Immediate scarcity or time-sensitive elements
- What is the call to action? - Single, crystal-clear action

Remember: In a 30-SECOND VSL, every word is precious. Focus only on the most compelling elements that drive immediate action. Complexity kills conversion in ultra-short format.

Be thorough and analytical in your breakdown. This analysis will be used to understand ultra-short VSL structure and effectiveness.`,
    });

    console.log(
      `Successfully extracted VSL script with ${vslScript.sections.length} sections`
    );

    return {
      ...inputData,
      vslScript,
    };
  },
});

const saveVSLStep = createStep({
  id: "save-vsl-analysis",
  description: "Saves the VSL analysis to a structured file format",
  inputSchema: z.object({
    transcript: z.string().describe("The video transcript text"),
    transcriptFileName: z
      .string()
      .describe("The path to the saved transcript file"),
    videoFileDeleted: z
      .boolean()
      .describe("Whether the original video file was deleted"),
    videoId: z.string().describe("The ID of the YouTube video"),
    vslScript: vslScriptSchema.describe("Extracted and structured VSL script"),
  }),
  outputSchema: z.object({
    transcript: z.string().describe("The video transcript text"),
    vslScript: vslScriptSchema.describe("Extracted and structured VSL script"),
    vslFileName: z.string().describe("The path to the saved VSL analysis file"),
    summary: z
      .object({
        totalSections: z
          .number()
          .describe("Total number of VSL sections identified"),
        mainPurposes: z
          .array(z.string())
          .describe("List of main marketing purposes found"),
        dominantTones: z
          .array(z.string())
          .describe("Most frequently used tones"),
        effectivenessRating: z
          .number()
          .describe("Overall effectiveness rating"),
      })
      .describe("Summary of the VSL analysis"),
  }),
  execute: async ({ inputData }) => {
    console.log("Saving VSL analysis to file...");

    // Create VSL analysis output directory
    const outputDir = "./vsl-analysis/";
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Generate VSL analysis filename
    const videoId = inputData.videoId;
    const vslFileName = path.join(outputDir, `${videoId}_vsl_analysis.json`);

    // Create comprehensive VSL analysis object
    const vslAnalysis = {
      metadata: {
        videoId,
        analysisDate: new Date().toISOString(),
        transcriptSource: inputData.transcriptFileName,
      },
      vslScript: inputData.vslScript,
      statistics: {
        totalSections: inputData.vslScript.sections.length,
        purposeBreakdown: inputData.vslScript.sections.reduce(
          (acc: Record<string, number>, section) => {
            acc[section.purpose] = (acc[section.purpose] || 0) + 1;
            return acc;
          },
          {}
        ),
        toneBreakdown: inputData.vslScript.sections.reduce(
          (acc: Record<string, number>, section) => {
            acc[section.tone] = (acc[section.tone] || 0) + 1;
            return acc;
          },
          {}
        ),
      },
    };

    // Save to JSON file
    fs.writeFileSync(vslFileName, JSON.stringify(vslAnalysis, null, 2), "utf8");
    console.log(`VSL analysis saved to: ${vslFileName}`);

    // Generate summary
    const purposes = Object.keys(vslAnalysis.statistics.purposeBreakdown);
    const tones = Object.entries(vslAnalysis.statistics.toneBreakdown)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([tone]) => tone);

    const summary = {
      totalSections: inputData.vslScript.sections.length,
      mainPurposes: purposes,
      dominantTones: tones,
      effectivenessRating: inputData.vslScript.effectiveness.overallRating,
    };

    console.log(`VSL Analysis Summary:
- Total sections: ${summary.totalSections}
- Main purposes: ${summary.mainPurposes.join(", ")}
- Dominant tones: ${summary.dominantTones.join(", ")}
- Effectiveness rating: ${summary.effectivenessRating}/10`);

    return {
      transcript: inputData.transcript,
      vslScript: inputData.vslScript,
      vslFileName,
      summary,
    };
  },
});

// Main VSL workflow that downloads, transcribes, and analyzes VSL structure
export const youtubeVSLWorkflow = createWorkflow({
  id: "youtube-vsl-workflow",
  description:
    "Downloads a YouTube video, transcribes it, and extracts a structured VSL script with sections, purposes, and tones",
  inputSchema: z.object({
    videoId: z
      .string()
      .describe("The ID of the YouTube video to analyze as a VSL"),
  }),
  outputSchema: z.object({
    transcript: z.string().describe("The transcribed text from the video"),
    vslScript: vslScriptSchema.describe("Extracted and structured VSL script"),
    vslFileName: z.string().describe("The path to the saved VSL analysis file"),
    summary: z
      .object({
        totalSections: z
          .number()
          .describe("Total number of VSL sections identified"),
        mainPurposes: z
          .array(z.string())
          .describe("List of main marketing purposes found"),
        dominantTones: z
          .array(z.string())
          .describe("Most frequently used tones"),
        effectivenessRating: z
          .number()
          .describe("Overall effectiveness rating"),
      })
      .describe("Summary of the VSL analysis"),
  }),
})
  .then(downloadVideoStep) // Download video if needed
  .then(getTranscriptStep) // Get transcript
  .then(extractVSLStep) // Extract VSL structure
  .then(saveVSLStep); // Save analysis

youtubeVSLWorkflow.commit();
