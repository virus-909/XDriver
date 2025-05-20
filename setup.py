from setuptools import setup, find_packages


setup(
    name="x_driver",
    author="Arjun Shankar",
    author_email="arjun.sha2425@gmail.com",
    description="Patched playwright driver",
    long_description=open("README.md").read(),
    long_description_content_type="text/markdown",
    license="MIT",
    version=" ".join([i.strip() for i in open("VERSION.txt")]).strip(),
    packages=find_packages(),
    include_package_data=True,
    entry_points={
        "console_scripts": [
            "x_driver=x_driver.__main__:activator",
        ],
    },
)
