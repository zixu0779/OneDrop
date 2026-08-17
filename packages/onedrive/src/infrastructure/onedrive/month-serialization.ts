import type { MonthDocument } from "@onedrop/core/domain/month-document";

export function serializeMonthDocument(document: MonthDocument): string {
  const messages = document.messages
    .map(
      (message, index) =>
        `    ${JSON.stringify(message)}${index < document.messages.length - 1 ? "," : ""}`,
    )
    .join("\n");
  return [
    "{",
    `  "schemaVersion": ${document.schemaVersion},`,
    `  "month": ${JSON.stringify(document.month)},`,
    '  "messages": [',
    messages,
    "  ]",
    "}",
  ].join("\n");
}

export function getMessageLines(
  serialized: string,
  document: MonthDocument,
): Record<string, number> {
  const lines = serialized.split("\n");
  return Object.fromEntries(
    document.messages.map((message) => {
      const value = JSON.stringify(message.id);
      const index = lines.findIndex(
        (line) =>
          line.includes(`"id":${value}`) || line.includes(`"id": ${value}`),
      );
      return [message.id, index < 0 ? 1 : index + 1];
    }),
  );
}

export function serializedDocumentBytes(document: MonthDocument): number {
  return new TextEncoder().encode(serializeMonthDocument(document)).byteLength;
}
