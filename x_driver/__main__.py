import argparse
from x_driver.activator import Activator


def activator():

    activator = Activator()

    parser = argparse.ArgumentParser(prog="x_driver")
    subparsers = parser.add_subparsers(dest="command")

    # Activate command
    activate_parser = subparsers.add_parser("activate", help="Activate the driver")
    activate_parser.set_defaults(func=activator.activate)

    # Deactivate command
    deactivate_parser = subparsers.add_parser("deactivate", help="Deactivate the driver")
    deactivate_parser.set_defaults(func=activator.deactivate)

    args = parser.parse_args()
    if hasattr(args, "func"):
        args.func()
    else:
        parser.print_help()
