from pathlib import Path
import json


class Activator:

    def __init__(self):
        self.METADATA = None

    def activate(self):
        try:
            import playwright

            BASE_PATH = Path(playwright.__file__).parent
        except ModuleNotFoundError:
            print("Playwright Not installed")

        print("HELLO")

    def deactivate(self):
        pass

