/**
 * The bundled logo images, by the `logo` key a registry entry names. The
 * registry is plain data shared with the agent and cannot import assets; this
 * is the one place a key becomes a file. A key with no file here falls back to
 * the vector marks in connector-logo.tsx, and the logo test catches a
 * connector with neither.
 */
import confluenceLogo from "../../assets/connectors/confluence.png";
import docusignLogo from "../../assets/connectors/docusign.webp";
import dropboxLogo from "../../assets/connectors/dropbox.png";
import figmaLogo from "../../assets/connectors/figma.webp";
import gcpLogo from "../../assets/connectors/gcs.png";
import githubLogo from "../../assets/connectors/github.webp";
import gmailLogo from "../../assets/connectors/gmail.png";
import googleCalendarLogo from "../../assets/connectors/google_calendar.webp";
import googleDriveLogo from "../../assets/connectors/google_drive.webp";
import jiraLogo from "../../assets/connectors/jira.webp";
import onedriveLogo from "../../assets/connectors/onedrive.webp";
import outlookLogo from "../../assets/connectors/outlook.webp";
import slackLogo from "../../assets/connectors/slack.png";
import xLogo from "../../assets/connectors/x.webp";
import zoomLogo from "../../assets/connectors/zoom.webp";

export const LOGO_ASSETS: Readonly<Record<string, string>> = {
  confluence: confluenceLogo,
  docusign: docusignLogo,
  dropbox: dropboxLogo,
  figma: figmaLogo,
  gcp: gcpLogo,
  github: githubLogo,
  gmail: gmailLogo,
  "google-calendar": googleCalendarLogo,
  "google-drive": googleDriveLogo,
  jira: jiraLogo,
  onedrive: onedriveLogo,
  outlook: outlookLogo,
  slack: slackLogo,
  x: xLogo,
  zoom: zoomLogo,
};
