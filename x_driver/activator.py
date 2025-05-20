from pathlib import Path
from x_driver._utils import Utils
import os
import shutil


class Activator(Utils):

    def _patch(self, PLAYWRIGHT_PATH, config):
        for filename, filepath in config.items():
            # Caching the base file by renaming
            CURRENT_FILEPATH = os.path.join(PLAYWRIGHT_PATH, "driver", filepath, filename)
            CACHE_FILEPATH = os.path.join(PLAYWRIGHT_PATH, "driver", filepath, f"_{filename}")
            os.rename(CURRENT_FILEPATH, CACHE_FILEPATH)

            BASE_DIR = os.path.dirname(os.path.abspath(__file__))
            PATCH_FILEPATH = os.path.join(BASE_DIR, "driver", filename)
            shutil.copy(PATCH_FILEPATH, CURRENT_FILEPATH)

    def _unpatch(self, PLAYWRIGHT_PATH, config):
        for filename, filepath in config.items():
            CURRENT_FILEPATH = os.path.join(PLAYWRIGHT_PATH, "driver", filepath, filename)
            CACHE_FILEPATH = os.path.join(PLAYWRIGHT_PATH, "driver", filepath, f"_{filename}")
            if not os.path.exists(CACHE_FILEPATH):
                continue

            os.remove(CURRENT_FILEPATH)
            os.rename(CACHE_FILEPATH, CURRENT_FILEPATH)

    def activate(self):
        try:
            import playwright
            PLAYWRIGHT_PATH = Path(playwright.__file__).parent
        except ModuleNotFoundError:
            print("Playwright Not installed")
            return

        config = self.load_config()
        self._patch(config=config, PLAYWRIGHT_PATH=PLAYWRIGHT_PATH)

    def deactivate(self):
        try:
            import playwright
            PLAYWRIGHT_PATH = Path(playwright.__file__).parent
        except ModuleNotFoundError:
            print("Playwright Not installed")
            return

        config = self.load_config()
        self._unpatch(config=config, PLAYWRIGHT_PATH=PLAYWRIGHT_PATH)
