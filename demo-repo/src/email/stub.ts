export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

const cloneMessage = (message: EmailMessage): EmailMessage => ({ ...message });

export class MemoryEmailSender implements EmailSender {
  private readonly messages: EmailMessage[] = [];

  get sent(): EmailMessage[] {
    return this.messages.map(cloneMessage);
  }

  async send(message: EmailMessage): Promise<void> {
    this.messages.push(cloneMessage(message));
  }
}
