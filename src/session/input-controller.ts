// Routes one raw user submission through the session port as wizard input,
// slash command input, or natural-language work.
export interface InputControllerSubmitOptions {
  awaitAsyncWork?: boolean;
  rethrowErrors?: boolean;
}

export interface InputControllerSubmitResult {
  exitRequested: boolean;
}

export interface InputControllerPort {
  appendUserInput(input: string): void;
  handleCommand(input: string): Promise<boolean>;
  handleNaturalLanguageInput(input: string): Promise<void>;
  waitForAsyncWork(): Promise<void>;
  handleSubmitError(error: unknown): void;
}

/** Coordinates input submission flow without owning any session state itself. */
export class InputController {
  constructor(private readonly port: InputControllerPort) {}

  async submit(
    rawInput: string,
    options: InputControllerSubmitOptions = {},
  ): Promise<InputControllerSubmitResult> {
    const userInput = rawInput.trim();
    if (!userInput) {
      return { exitRequested: false };
    }

    this.port.appendUserInput(userInput);

    try {
      if (userInput.startsWith('/')) {
        const exitRequested = await this.port.handleCommand(userInput);
        if (options.awaitAsyncWork) {
          await this.port.waitForAsyncWork();
        }
        return { exitRequested };
      }

      await this.port.handleNaturalLanguageInput(userInput);
      if (options.awaitAsyncWork) {
        await this.port.waitForAsyncWork();
      }
      return { exitRequested: false };
    } catch (error) {
      this.port.handleSubmitError(error);
      if (options.awaitAsyncWork) {
        await this.port.waitForAsyncWork();
      }
      if (options.rethrowErrors) throw error;
      return { exitRequested: false };
    }
  }
}
