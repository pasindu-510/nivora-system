"""Shop API project package.

Register PyMySQL as the MySQLdb-compatible driver so Django's MySQL
backend works without a compiled mysqlclient wheel (Windows dev and
cPanel both fine with PyMySQL). PyMySQL is pinned in requirements.txt.
"""
import pymysql

pymysql.install_as_MySQLdb()
