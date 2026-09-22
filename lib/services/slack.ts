import { HttpClient } from "./httpClient";
import { config } from "../utils/configuration/config";

interface SlackMessage {
  text?: string;
  username?: string;
  icon_emoji?: string;
  channel?: string;
  blocks?: any[];
  attachments?: any[];
}

class SlackService {
  private webhookUrl: string;

  constructor() {
    // Use the webhook URL from environment variable for better security
    this.webhookUrl = config.SLACK_WEBHOOK_ADMIN_REGISTRATION;

    if (!this.webhookUrl) {
      console.warn(
        "SLACK_WEBHOOK_ADMIN_REGISTRATION is not set in environment variables",
      );
    }
  }

  /**
   * Send a message to Slack
   */
  public async sendMessage(message: SlackMessage): Promise<boolean> {
    // Check if webhook URL is configured
    if (!this.webhookUrl) {
      console.warn(
        "Cannot send Slack message: SLACK_WEBHOOK_ADMIN_REGISTRATION is not configured",
      );
      return false;
    }

    try {
      const response = await HttpClient.Request({
        url: this.webhookUrl,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        data: message,
      });

      return response === "ok";
    } catch (error) {
      console.error("Failed to send Slack message:", error);
      return false;
    }
  }

  /**
   * Send admin registration notification
   */
  public async notifyAdminRegistration(adminData: {
    name: string;
    email: string;
    phone?: string;
    companyName?: string;
    userRole?: string;
    registeredAt?: Date;
  }): Promise<boolean> {
    const timestamp = adminData.registeredAt || new Date();
    const formattedTime = timestamp.toLocaleString("en-US", {
      timeZone: "America/New_York",
      dateStyle: "medium",
      timeStyle: "short",
    });

    const message: SlackMessage = {
      username: "RelayCam Registration Bot",
      icon_emoji: ":new:",
      text: "New Admin User Registration",
      channel: "#admin-notifications",
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: "🎉 New Admin User Registration",
            emoji: true,
          },
        },
        {
          type: "section",
          fields: [
            {
              type: "mrkdwn",
              text: `*Name:*\n${adminData.name}`,
            },
            {
              type: "mrkdwn",
              text: `*Email:*\n${adminData.email}`,
            },
            {
              type: "mrkdwn",
              text: `*Phone:*\n${adminData.phone || "N/A"}`,
            },
            {
              type: "mrkdwn",
              text: `*Company:*\n${adminData.companyName || "N/A"}`,
            },
            {
              type: "mrkdwn",
              text: `*Role:*\n${adminData.userRole || "Admin"}`,
            },
            {
              type: "mrkdwn",
              text: `*Registered At:*\n${formattedTime}`,
            },
          ],
        },
        {
          type: "divider",
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Registered via RelayCam Backend API | Environment: ${config.NODE_ENV || "production"}`,
            },
          ],
        },
      ],
    };

    return this.sendMessage(message);
  }

  /**
   * Send a simple notification message
   */
  public async sendSimpleNotification(text: string): Promise<boolean> {
    return this.sendMessage({
      text,
      username: "RelayCam Bot",
      icon_emoji: ":information_source:",
    });
  }
}

// Export singleton instance
export const slackService = new SlackService();

// Export class for testing or custom instances
export { SlackService };
