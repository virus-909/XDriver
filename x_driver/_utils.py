import os
import json


class Utils:

    def load_config(self):
        BASE_DIR = os.path.dirname(os.path.abspath(__file__))
        CONFIG_PATH = "config.json"
        FULL_PATH = os.path.join(BASE_DIR, CONFIG_PATH)
        with open(FULL_PATH) as file:
            config = json.load(file)
            return config


